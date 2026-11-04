import path from "node:path";
import { KnownFailure } from "@/server/core/paid-call";

// SECURITY CONTROL (Phase 5d): the boundary of the native 3D render, the one render that runs on the host and not in the
// locked Docker container. What runs is our own composition (remotion/kit) plus a validated scene file plus the fixed
// catalogue models; no model-written code, no downloaded code. The boundary is macOS sandbox-exec with the profile below:
//   network   denied, except bind/accept/connect on loopback (Remotion's local file server and Chrome's devtools socket use 127.0.0.1);
//   writes    denied everywhere except the job's out folder, one private temp folder (also HOME and TMPDIR) and /dev/null-like devices;
//   reads     the home folder, the repo and the storage root are denied; only the kit, node_modules, the repo's package.json,
//             the job's in folder, the out and temp folders, the node install and the Chrome headless shell folder are readable.
// ACCEPTED RESIDUAL RISKS (reviewed; the scene is our own validated data, not code):
//   - the profile is `(allow default)` plus denies, not deny-default (deny-default cannot be made to work for Chrome blind);
//   - loopback stays open, so another local service (database, Redis) is reachable from inside; binding a port on loopback is allowed;
//   - mach lookups, the pasteboard, process exec and signals are not restricted (see strictExec below; off until a real render proves it);
//   - reads outside home, repo and storage (for example /etc) are allowed; file METADATA (stat/realpath) is not denied on the
//     protected trees: tested, denying it makes realpath() of an allowed folder fail (EPERM on its parents), which webpack and Chrome use.
// The program is started with `env -i`: no secret of the worker (database url, keys) reaches it.
// Seatbelt applies the LAST matching rule, so each allow below sits after the deny it carves a hole in.

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
export const NICE = "/usr/bin/nice";
export const ENV = "/usr/bin/env";

export interface NativeSandboxPaths {
  /** Real (symlink-free) absolute paths. */
  repoRoot: string;
  kitDir: string;
  nodeModules: string;
  storageRoot: string;
  homeDir: string;
  /** The job: in folder (read), out folder (write), private temp folder (write; HOME and TMPDIR). */
  inDir: string;
  outDir: string;
  tmpDir: string;
  /** Folders node and Chrome are read from: the node install prefix, the Chrome headless shell folder. */
  nodePrefix: string;
  chromeDir: string;
}

// A path goes into a quoted Seatbelt string: refuse anything that could close the string or start another form.
const SAFE_PATH = /^\/[^"\\\0\r\n()]*$/;
const q = (p: string): string => {
  if (!path.isAbsolute(p) || path.normalize(p) !== p || !SAFE_PATH.test(p) || p === "/") throw new KnownFailure("A native render folder has a path that cannot be put in the sandbox safely.");
  return `"${p}"`;
};

// OPTIONAL stricter profile (off; nothing turns it on): only programs under the node install, the Chrome shell folder and the
// system folders may be started. It cannot be proven without a real render (Chrome may start helpers from elsewhere), so the
// owner should try it by hand after a first successful real render: call buildSandboxProfile(paths, { strictExec: true }).
const strictExecRules = (p: NativeSandboxPaths): string[] => [
  "(deny process-exec*)",
  `(allow process-exec* (subpath ${q(p.nodePrefix)}) (subpath ${q(p.chromeDir)}) (subpath "/usr/bin") (subpath "/bin") (subpath "/usr/libexec") (subpath "/System"))`,
];

/** The sandbox-exec profile text. Builds only; runs nothing. Throws KnownFailure for an unusable path. */
export function buildSandboxProfile(p: NativeSandboxPaths, opts: { strictExec?: boolean } = {}): string {
  const read = [p.kitDir, p.nodeModules, p.inDir, p.outDir, p.tmpDir, p.nodePrefix, p.chromeDir].map((d) => `(subpath ${q(d)})`).join(" ");
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    // Three separate rules, each with the filter on the side it can mean. One `network*` rule with both a local and a remote
    // filter let ANY outbound connect through (Seatbelt ORs the filters): curl http://1.1.1.1 returned 301.
    '(allow network-bind (local ip "localhost:*"))',
    '(allow network-inbound (local ip "localhost:*"))',
    '(allow network-outbound (remote ip "localhost:*"))',
    "(deny file-write*)",
    `(allow file-write* (subpath ${q(p.outDir)}) (subpath ${q(p.tmpDir)}) (literal "/dev/null") (literal "/dev/dtracehelper") (regex #"^/dev/(tty|ttys[0-9]+|fd/[0-9]+)$"))`,
    `(deny file-read-data (subpath ${q(p.homeDir)}) (subpath ${q(p.repoRoot)}) (subpath ${q(p.storageRoot)}))`,
    `(allow file-read-data ${read} (literal ${q(path.join(p.repoRoot, "package.json"))}))`,
    ...(opts.strictExec ? strictExecRules(p) : []),
    "",
  ].join("\n");
}

export interface NativeCommandInput extends NativeSandboxPaths {
  /** Absolute path of the node binary that runs render-entry.mjs. */
  node: string;
  /** Absolute path of the finished mp4. */
  outFile: string;
}

/** `nice -n 10 sandbox-exec -p <profile> env -i PATH HOME TMPDIR node render-entry.mjs <in> <out> --scale3d --native` */
export function nativeCommand(i: NativeCommandInput): { command: string; args: string[] } {
  if (!path.isAbsolute(i.node) || !path.isAbsolute(i.outFile) || path.dirname(i.outFile) !== i.outDir) throw new KnownFailure("The native render has a bad program or output path.");
  return {
    command: NICE,
    args: [
      "-n", "10",
      SANDBOX_EXEC, "-p", buildSandboxProfile(i),
      ENV, "-i", `PATH=${path.dirname(i.node)}:/usr/bin:/bin`, `HOME=${i.tmpDir}`, `TMPDIR=${i.tmpDir}`,
      i.node, path.join(i.kitDir, "render-entry.mjs"), i.inDir, i.outFile, "--scale3d", "--native",
    ],
  };
}
