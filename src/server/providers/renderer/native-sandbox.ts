import path from "node:path";
import { KnownFailure } from "@/server/core/paid-call";
import { CHROME_BIN } from "./native-preflight";

// SECURITY CONTROL (Phase 5d, tightened in Phase 5e): the boundary of the native 3D render, the one render that runs on the host and not in the
// locked Docker container. It runs our own composition (remotion/kit), the fixed catalogue models and, for 3D stories with an AI-written
// scene, ONE statically checked, type-checked, owner-approved scene.tsx that is bundled and run inside the page. The scene is UNTRUSTED code:
// this profile is the last of four layers (checker, bundler allow-list, page guard). The boundary is macOS sandbox-exec with the profile below:
//   network   denied, except bind/accept/connect on loopback (Remotion's local file server and Chrome's devtools socket use 127.0.0.1); the page
//             itself is locked to its own origin by net-guard.mjs, so other loopback services stay out of reach of scene JavaScript;
//   writes    denied everywhere except the job's out folder, one private temp folder (also HOME and TMPDIR) and /dev/null-like devices;
//   reads     /Users, /Volumes, /tmp, /var/tmp and /var/folders are denied (so are home, repo and storage root), then only the kit, node_modules,
//             the repo's package.json and tsconfig.json, the job's in folder, the out and temp folders, the node install and the Chrome headless
//             shell folder are allowed back (last matching rule wins);
//   processes only env, the node binary, the Chrome folder, node_modules (Remotion's compositor) and the Chrome wrapper script may be started:
//             no shell, open, osascript, launchctl, security, curl, nc, ssh or python; signals only to self and the process group;
//   services  mach lookups of launch services, the security server (keychain) and the pasteboard are denied.
// ACCEPTED RESIDUAL RISKS (reviewed):
//   - the profile is `(allow default)` plus denies, not deny-default (deny-default cannot be made to work for Chrome blind);
//   - loopback stays open to the render process, so another local service (database, Redis) is reachable from outside the page;
//   - other mach services, and reads outside the denied trees (for example /etc, /usr), are allowed; file METADATA (stat/realpath) is not
//     denied on the protected trees: tested, denying it makes realpath() of an allowed folder fail (EPERM on its parents).
// The program is started with `env -i`: no secret of the worker (database url, keys) reaches it. Only PATH, HOME, TMPDIR and
// REMOTION_BROWSER_EXECUTABLE are set. The working directory must be the temp folder: process.cwd() fails with EPERM anywhere
// under the denied storage root that is not itself allowed. Remotion looks for Chrome from the cwd, so the path is given explicitly.
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
  /** The node binary that is allowed to start (real path). Absent: the whole node install folder. */
  node?: string;
}

// A path goes into a quoted Seatbelt string: refuse anything that could close the string or start another form.
const SAFE_PATH = /^\/[^"\\\0\r\n()]*$/;
const q = (p: string): string => {
  if (!path.isAbsolute(p) || path.normalize(p) !== p || !SAFE_PATH.test(p) || p === "/") throw new KnownFailure("A native render folder has a path that cannot be put in the sandbox safely.");
  return `"${p}"`;
};

// The only single files of the repo root the render may read (everything else of the repo stays denied): package.json (browserslist,
// Remotion) and tsconfig.json (Remotion's esbuild loader reads it while bundling; found by the first real run). Both are plain config.
/** Whole trees no render may read (home folders, other volumes, the shared temp folders): the job's own folders are allowed back after this. */
export const DENIED_READ_TREES = ["/Users", "/Volumes", "/private/tmp", "/private/var/tmp", "/private/var/folders"] as const;
/** Launch, keychain and pasteboard services: nothing in a render needs them (Chrome runs with a mock keychain). */
export const DENIED_SERVICES = ["com.apple.coreservices.launchservicesd", "com.apple.SecurityServer", "com.apple.pasteboard.1"] as const;
export const REPO_FILES = ["package.json", "tsconfig.json"] as const;

/** The sandbox-exec profile text. Builds only; runs nothing. Throws KnownFailure for an unusable path. */
export function buildSandboxProfile(p: NativeSandboxPaths): string {
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
    `(deny file-read-data ${DENIED_READ_TREES.map((d) => `(subpath "${d}")`).join(" ")})`,
    `(allow file-read-data ${read} ${REPO_FILES.map((f) => `(literal ${q(path.join(p.repoRoot, f))})`).join(" ")})`,
    "(deny process-exec*)",
    `(allow process-exec* (literal "${ENV}") ${p.node ? `(literal ${q(p.node)})` : `(subpath ${q(p.nodePrefix)})`} (literal ${q(path.join(p.tmpDir, "chrome-guard.js"))}) (subpath ${q(p.chromeDir)}) (subpath ${q(p.nodeModules)}))`,
    "(deny signal (target others))",
    "(allow signal (target self) (target pgrp) (target children))",
    `(deny mach-lookup ${DENIED_SERVICES.map((n) => `(global-name "${n}")`).join(" ")})`,
    "",
  ].join("\n");
}

export interface NativeCommandInput extends NativeSandboxPaths {
  /** Absolute path of the node binary that runs render-entry.mjs. */
  node: string;
  /** Absolute path of the finished mp4 (for --scene3d-stills: the out folder itself, where the pictures go). */
  outFile: string;
  /** Which composition: the 3D scale kit (default), the general 3D scene engine, or preview pictures of that scene. */
  mode?: "--scale3d" | "--scene3d" | "--scene3d-stills" | "--scene3d-code" | "--scene3d-code-stills";
  /** Authored-scene modes only: sha256 of scene.tsx. render-entry.mjs hashes the file before bundling and aborts on any difference. */
  expectSha?: string;
}

/** `nice -n 10 sandbox-exec -p <profile> env -i PATH HOME TMPDIR node render-entry.mjs <in> <out> --scale3d|--scene3d --native` */
export function nativeCommand(i: NativeCommandInput): { command: string; args: string[] } {
  const outOk = i.mode === "--scene3d-stills" || i.mode === "--scene3d-code-stills" ? i.outFile === i.outDir : path.dirname(i.outFile) === i.outDir;
  const codeMode = i.mode === "--scene3d-code" || i.mode === "--scene3d-code-stills";
  if (codeMode !== (i.expectSha !== undefined) || (i.expectSha !== undefined && !/^[0-9a-f]{64}$/.test(i.expectSha))) throw new KnownFailure("The native render has a bad scene fingerprint.");
  if (!path.isAbsolute(i.node) || !path.isAbsolute(i.outFile) || !outOk) throw new KnownFailure("The native render has a bad program or output path.");
  return {
    command: NICE,
    args: [
      "-n", "10",
      SANDBOX_EXEC, "-p", buildSandboxProfile(i),
      ENV, "-i", `PATH=${path.dirname(i.node)}:/usr/bin:/bin`, `HOME=${i.tmpDir}`, `TMPDIR=${i.tmpDir}`, `REMOTION_BROWSER_EXECUTABLE=${path.join(i.chromeDir, CHROME_BIN)}`,
      i.node, path.join(i.kitDir, "render-entry.mjs"), i.inDir, i.outFile, i.mode ?? "--scale3d", "--native", ...(i.expectSha ? ["--expect-sha", i.expectSha] : []),
    ],
  };
}
