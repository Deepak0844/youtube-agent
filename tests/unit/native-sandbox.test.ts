import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KnownFailure } from "@/server/core/paid-call";
import { buildSandboxProfile, DENIED_READ_TREES, DENIED_SERVICES, nativeCommand, type NativeSandboxPaths } from "@/server/providers/renderer/native-sandbox";
import { REMOTION_PIN } from "@/server/providers/renderer/native-preflight";

const P: NativeSandboxPaths = {
  repoRoot: "/Users/me/app",
  kitDir: "/Users/me/app/remotion/kit",
  nodeModules: "/Users/me/app/node_modules",
  storageRoot: "/Users/me/app/.data",
  homeDir: "/Users/me",
  inDir: "/Users/me/app/.data/videos/v1/a1/native-in",
  outDir: "/Users/me/app/.data/videos/v1/a1/native-out",
  tmpDir: "/Users/me/app/.data/videos/v1/a1/native-tmp",
  nodePrefix: "/Users/me/.nvm/versions/node/v22",
  chromeDir: "/Users/me/app/node_modules/.remotion/chrome-headless-shell/mac-arm64",
};
const lines = (s: string) => s.split("\n").filter(Boolean);

describe("sandbox profile", () => {
  const profile = buildSandboxProfile(P);

  it("denies the network, then allows only loopback bind, accept and connect, each with its own filter", () => {
    expect(profile).toContain("(deny network*)");
    const allows = lines(profile).filter((l) => l.startsWith("(allow network"));
    expect(allows).toEqual([
      '(allow network-bind (local ip "localhost:*"))',
      '(allow network-inbound (local ip "localhost:*"))',
      '(allow network-outbound (remote ip "localhost:*"))',
    ]);
    // regression: one `network*` rule with a local AND a remote filter let any outbound connect through
    for (const l of allows) {
      expect(l).not.toMatch(/^\(allow network\*/);
      if (l.startsWith("(allow network-outbound")) expect(l).not.toContain("local ip");
    }
    expect(profile.indexOf("(deny network*)")).toBeLessThan(profile.indexOf("(allow network-bind"));
  });

  it("denies process exec by default and allows only env, node, the Chrome folder, node_modules and the Chrome wrapper; signals only to self, children and the group; three services", () => {
    const l = lines(profile);
    const i = l.indexOf("(deny process-exec*)");
    expect(i).toBeGreaterThan(l.findIndex((x) => x.startsWith("(allow file-read-data")));
    expect(l[i + 1]).toBe(`(allow process-exec* (literal "/usr/bin/env") (subpath "${P.nodePrefix}") (literal "${P.tmpDir}/chrome-guard.js") (subpath "${P.chromeDir}") (subpath "${P.nodeModules}"))`);
    expect(buildSandboxProfile({ ...P, node: "/Users/me/.nvm/versions/node/v22/bin/node" })).toContain('(literal "/Users/me/.nvm/versions/node/v22/bin/node")');
    expect(l).toContain("(deny signal (target others))");
    expect(l).toContain("(allow signal (target self) (target pgrp) (target children))");
    expect(l).toContain(`(deny mach-lookup ${DENIED_SERVICES.map((n) => `(global-name "${n}")`).join(" ")})`);
    expect(DENIED_SERVICES).toEqual(["com.apple.coreservices.launchservicesd", "com.apple.SecurityServer", "com.apple.pasteboard.1"]);
    for (const bin of ["/usr/bin/open", "osascript", "launchctl", "/usr/bin/security", "curl", "/usr/bin/nc", "ssh", "python", "/bin/sh", "/bin/zsh", "/bin/bash"]) expect(l.filter((x) => x.startsWith("(allow process-exec*")).join()).not.toContain(bin);
  });

  it("denies every write, then allows only the out folder, the private temp folder and null-like devices", () => {
    const l = lines(profile);
    expect(l).toContain("(deny file-write*)");
    const allow = l.filter((x) => x.startsWith("(allow file-write*"));
    expect(allow).toHaveLength(1);
    const paths = [...allow[0]!.matchAll(/\((?:subpath|literal) "([^"]+)"\)/g)].map((m) => m[1]);
    expect(paths).toEqual([P.outDir, P.tmpDir, "/dev/null", "/dev/dtracehelper"]);
    for (const forbidden of [P.homeDir + '"', P.repoRoot + '"', P.storageRoot + '"', P.kitDir, P.inDir, P.nodeModules]) expect(allow[0]).not.toContain(forbidden);
    expect(l.indexOf("(deny file-write*)")).toBeLessThan(l.indexOf(allow[0]!));
  });

  it("no rule allows a write to the home folder, the repo or the storage root", () => {
    const writeAllows = lines(profile).filter((l) => /^\(allow (file-write|default|file\*)/.test(l) && l !== "(allow default)");
    expect(writeAllows.join("\n")).not.toMatch(/"\/Users\/me"|"\/Users\/me\/app"|"\/Users\/me\/app\/\.data"/);
    // the only broad allow is the first line; the write deny follows it, so it wins for writes
    expect(lines(profile)[1]).toBe("(allow default)");
    expect(lines(profile).indexOf("(deny file-write*)")).toBeGreaterThan(1);
  });

  it("denies reads of home, repo and storage, then allows back only what the render needs", () => {
    const l = lines(profile);
    const deny = l.find((x) => x.startsWith("(deny file-read-data"))!;
    expect(deny).toBe(`(deny file-read-data (subpath "${P.homeDir}") (subpath "${P.repoRoot}") (subpath "${P.storageRoot}"))`);
    const trees = l.find((x) => x.startsWith("(deny file-read-data") && x !== deny)!;
    expect(trees).toBe(`(deny file-read-data ${DENIED_READ_TREES.map((d) => `(subpath "${d}")`).join(" ")})`);
    expect(DENIED_READ_TREES).toEqual(["/Users", "/Volumes", "/private/tmp", "/private/var/tmp", "/private/var/folders"]);
    expect(l.indexOf(trees)).toBeLessThan(l.findIndex((x) => x.startsWith("(allow file-read-data")));
    const allow = l.find((x) => x.startsWith("(allow file-read-data"))!;
    const paths = [...allow.matchAll(/\((?:subpath|literal) "([^"]+)"\)/g)].map((m) => m[1]);
    expect(paths).toEqual([P.kitDir, P.nodeModules, P.inDir, P.outDir, P.tmpDir, P.nodePrefix, P.chromeDir, `${P.repoRoot}/package.json`, `${P.repoRoot}/tsconfig.json`]);
    expect(l.indexOf(deny)).toBeLessThan(l.indexOf(allow));
  });

  it.each([
    ["a quote", { outDir: '/x/out"(allow default)' }],
    ["a backslash", { tmpDir: "/x/t\\mp" }],
    ["a newline", { inDir: "/x/in\n(allow network*)" }],
    ["a parenthesis", { chromeDir: "/x/chrome)" }],
    ["a relative path", { kitDir: "remotion/kit" }],
    ["a dot-dot path", { nodeModules: "/x/../node_modules" }],
    ["the root", { storageRoot: "/" }],
  ])("refuses a folder with %s", (_n, over) => {
    expect(() => buildSandboxProfile({ ...P, ...over })).toThrow(KnownFailure);
  });
});

// The REAL sandbox-exec, with negative controls for every newly denied thing (macOS only).
describe.runIf(process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec"))("the real sandbox", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "sbx-")));
  const job = path.join(root, "job");
  const dirs = { inDir: path.join(job, "in"), outDir: path.join(job, "out"), tmpDir: path.join(job, "tmp") };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  const node = realpathSync(process.execPath);
  const outside = mkdtempSync("/private/tmp/sbx-outside-");
  writeFileSync(path.join(outside, "secret.txt"), "x");
  mkdirSync(path.join(root, "job2", "tmp"), { recursive: true });
  const homeFile = path.join(homedir(), ".sbx-probe-file");
  writeFileSync(homeFile, "x");
  writeFileSync(path.join(dirs.inDir, "ok.txt"), "ok");
  const paths: NativeSandboxPaths = { repoRoot: path.resolve("."), kitDir: path.resolve("remotion/kit"), nodeModules: realpathSync(path.resolve("node_modules")), storageRoot: root, homeDir: realpathSync(homedir()), ...dirs, nodePrefix: path.dirname(path.dirname(node)), chromeDir: path.resolve("tests/fixtures"), node };
  /** Runs `code` in node under the profile; prints OK or the error code per probe. */
  const probe = (code: string): string[] => {
    const out = execFileSync("/usr/bin/sandbox-exec", ["-p", buildSandboxProfile(paths), "/usr/bin/env", "-i", `HOME=${dirs.tmpDir}`, node, "-e", code], { cwd: dirs.tmpDir, encoding: "utf8", timeout: 30_000 });
    return out.trim().split("\n");
  };
  const tries = (items: Record<string, string>): string => `const fs=require("fs"),cp=require("child_process");const r=(n,f)=>{try{f();console.log(n+" OK")}catch(e){console.log(n+" "+(e.code||e.message))}};${Object.entries(items).map(([n, f]) => `r(${JSON.stringify(n)},()=>{${f}});`).join("")}`;
  const result = probe(tries({
    inRead: `fs.readFileSync(${JSON.stringify(path.join(dirs.inDir, "ok.txt"))})`,
    tmpWrite: `fs.writeFileSync(${JSON.stringify(path.join(dirs.tmpDir, "w.txt"))},"x")`,
    privTmpRead: `fs.readFileSync(${JSON.stringify(path.join(outside, "secret.txt"))})`,
    homeRead: `fs.readFileSync(${JSON.stringify(homeFile)})`,
    varFoldersRead: `fs.readdirSync("/private/var/folders")`,
    volumesRead: `fs.readdirSync("/Volumes")`,
    usersRead: `fs.readdirSync("/Users")`,
    curl: `cp.execFileSync("/usr/bin/curl",["--version"])`,
    sh: `cp.execFileSync("/bin/sh",["-c","true"])`,
    zsh: `cp.execFileSync("/bin/zsh",["-c","true"])`,
    open: `cp.execFileSync("/usr/bin/open",["-h"])`,
    osascript: `cp.execFileSync("/usr/bin/osascript",["-e","1"])`,
    security: `cp.execFileSync("/usr/bin/security",["-h"])`,
    launchctl: `cp.execFileSync("/bin/launchctl",["version"])`,
    killInit: `process.kill(1,0)`,
    writeOutside: `fs.writeFileSync(${JSON.stringify(path.join(root, "outside-write.txt"))},"x")`,
    writeSibling: `fs.writeFileSync(${JSON.stringify(path.join(root, "job2", "tmp", "x.txt"))},"x")`,
    repoRead: `fs.readFileSync(${JSON.stringify(path.resolve("package-lock.json"))})`,
  }));
  const status = (n: string) => result.find((l) => l.startsWith(`${n} `))!.slice(n.length + 1);
  const denied = (n: string) => expect(status(n), n).toMatch(/^(EPERM|EACCES)$/);
  it("still reads its in folder and writes its temp folder (positive controls)", () => {
    expect(status("inRead")).toBe("OK");
    expect(status("tmpWrite")).toBe("OK");
  });
  it.each(["privTmpRead", "homeRead", "usersRead", "volumesRead", "varFoldersRead", "repoRead"])("cannot read %s (EPERM)", denied);
  it.each(["writeOutside", "writeSibling"])("cannot write: %s (EPERM)", denied);
  it("cannot signal init (EPERM)", () => denied("killInit"));
  it("cannot reach the network except loopback", () => {
    const out = probe(`const n=require("net");const s=n.connect({host:"1.1.1.1",port:80,timeout:3000});s.on("error",e=>{console.log("net "+e.code);process.exit(0)});s.on("connect",()=>{console.log("net OK");process.exit(0)});s.on("timeout",()=>{console.log("net TIMEOUT");process.exit(0)})`);
    expect(out[0]).toMatch(/^net (EPERM|EACCES|ENETUNREACH|EHOSTUNREACH)$/);
  });
  it.each(["curl", "sh", "zsh", "open", "osascript", "security", "launchctl"])("cannot start %s (EPERM)", (n) => expect(status(n), n).toMatch(/^(EPERM|EACCES)$/));
  it("cleans up", () => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    rmSync(homeFile, { force: true });
  });
});

describe("native command", () => {
  const cmd = nativeCommand({ ...P, node: "/Users/me/.nvm/versions/node/v22/bin/node", outFile: `${P.outDir}/out.mp4` });

  it("runs nice 10, then sandbox-exec with the profile, then env -i with only PATH, HOME, TMPDIR and the Chrome path", () => {
    expect(cmd.command).toBe("/usr/bin/nice");
    expect(cmd.args.slice(0, 4)).toEqual(["-n", "10", "/usr/bin/sandbox-exec", "-p"]);
    expect(cmd.args[4]).toBe(buildSandboxProfile({ ...P, node: "/Users/me/.nvm/versions/node/v22/bin/node" }));
    expect(cmd.args.slice(5, 8)).toEqual(["/usr/bin/env", "-i", expect.stringMatching(/^PATH=/)]);
    const envs = cmd.args.filter((a) => /^[A-Z_]+=/.test(a) && !a.includes("\n"));
    expect(envs.map((e) => e.split("=")[0])).toEqual(["PATH", "HOME", "TMPDIR", "REMOTION_BROWSER_EXECUTABLE"]);
    expect(cmd.args).toContain(`REMOTION_BROWSER_EXECUTABLE=${P.chromeDir}/chrome-headless-shell`); // Remotion finds Chrome from the cwd, which is no project
    expect(cmd.args).toContain(`HOME=${P.tmpDir}`);
    expect(cmd.args).toContain(`TMPDIR=${P.tmpDir}`);
  });

  it("ends with the entry script, the in folder, the out file, --scale3d and --native, in that order", () => {
    expect(cmd.args.slice(-6)).toEqual(["/Users/me/.nvm/versions/node/v22/bin/node", `${P.kitDir}/render-entry.mjs`, P.inDir, `${P.outDir}/out.mp4`, "--scale3d", "--native"]);
  });

  it("scene3d mode only swaps the mode word; the profile (and so the read allow-list) is the same, models are staged in the in folder", () => {
    const scene = nativeCommand({ ...P, node: "/Users/me/.nvm/versions/node/v22/bin/node", outFile: `${P.outDir}/out.mp4`, mode: "--scene3d" });
    expect(scene.args.slice(-6)).toEqual(["/Users/me/.nvm/versions/node/v22/bin/node", `${P.kitDir}/render-entry.mjs`, P.inDir, `${P.outDir}/out.mp4`, "--scene3d", "--native"]);
    expect(scene.args[4]).toBe(cmd.args[4]);
    expect(scene.args[4]).not.toContain("assets3d");
  });

  it("preview pictures: --scene3d-stills writes into the out FOLDER itself, same profile, and a file path is refused for it", () => {
    const stills = nativeCommand({ ...P, node: "/Users/me/.nvm/versions/node/v22/bin/node", outFile: P.outDir, mode: "--scene3d-stills" });
    expect(stills.args.slice(-6)).toEqual(["/Users/me/.nvm/versions/node/v22/bin/node", `${P.kitDir}/render-entry.mjs`, P.inDir, P.outDir, "--scene3d-stills", "--native"]);
    expect(stills.args[4]).toBe(cmd.args[4]);
    expect(() => nativeCommand({ ...P, node: "/n/node", outFile: `${P.outDir}/out.mp4`, mode: "--scene3d-stills" })).toThrow(KnownFailure);
    expect(() => nativeCommand({ ...P, node: "/n/node", outFile: P.outDir, mode: "--scene3d" })).toThrow(KnownFailure); // a video needs a file
  });

  it("refuses an output file outside the out folder and a relative node", () => {
    expect(() => nativeCommand({ ...P, node: "/n/node", outFile: "/tmp/out.mp4" })).toThrow(KnownFailure);
    expect(() => nativeCommand({ ...P, node: "node", outFile: `${P.outDir}/out.mp4` })).toThrow(KnownFailure);
  });
});

describe("the gl override and the container", () => {
  const entry = readFileSync("remotion/kit/render-entry.mjs", "utf8");

  it("render-entry honours native (angle gl, concurrency 1) only for --scale3d or --scene3d with exactly --native", () => {
    expect(entry).toContain('const native = (mode === "--scale3d" || mode === "--scene3d" || mode === "--scene3d-stills" || mode === "--scene3d-code" || mode === "--scene3d-code-stills") && extra.length === 1 && extra[0] === "--native";');
    expect(entry).toContain('(extra.length > 0 && !native)');
    expect(entry).toContain('((mode === "--scene3d" || mode === "--scene3d-stills" || mode === "--scene3d-code" || mode === "--scene3d-code-stills") && !native)'); // the container can never be asked to draw a 3D scene or its preview pictures
    expect(entry).toContain('scene3d ? "scene3d" : mode === "--scale3d" ? "scale3d" : "kit-video"');
    expect(entry).toContain('gl: native ? "angle" : "swangle"');
    expect(entry).toContain("...(native ? { concurrency: 1 } : {})");
    expect(entry).not.toMatch(/process\.env\.\w*GL\w*/);
  });

  it("the container renderer and the TSX renderers never pass --native", () => {
    for (const f of ["remotion-container.ts", "tsx-render.ts", "tsx-sandbox.ts"]) expect(readFileSync(`src/server/providers/renderer/${f}`, "utf8"), f).not.toContain("--native");
  });

  it("the host Remotion packages are pinned to the image version", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { devDependencies: Record<string, string>; dependencies: Record<string, string> };
    for (const m of ["@remotion/renderer", "@remotion/bundler", "@remotion/cli"]) expect(pkg.devDependencies[m], m).toBe(REMOTION_PIN);
    expect(pkg.dependencies.remotion).toBe(REMOTION_PIN);
    expect(readFileSync("infra/Dockerfile.render", "utf8")).toContain(`@remotion/renderer@${REMOTION_PIN}`);
  });
});
