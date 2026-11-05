import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { KnownFailure } from "@/server/core/paid-call";
import { buildSandboxProfile, nativeCommand, type NativeSandboxPaths } from "@/server/providers/renderer/native-sandbox";
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

  it("strictExec is off by default and, when asked for, adds a process-exec deny with a short allow list after the other rules", () => {
    expect(profile).not.toContain("process-exec");
    const strict = lines(buildSandboxProfile(P, { strictExec: true }));
    expect(strict.slice(0, lines(profile).length)).toEqual(lines(profile));
    expect(strict.slice(lines(profile).length)).toEqual([
      "(deny process-exec*)",
      `(allow process-exec* (subpath "${P.nodePrefix}") (subpath "${P.chromeDir}") (subpath "/usr/bin") (subpath "/bin") (subpath "/usr/libexec") (subpath "/System"))`,
    ]);
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
    const allow = l.find((x) => x.startsWith("(allow file-read-data"))!;
    const paths = [...allow.matchAll(/\((?:subpath|literal) "([^"]+)"\)/g)].map((m) => m[1]);
    expect(paths).toEqual([P.kitDir, P.nodeModules, P.inDir, P.outDir, P.tmpDir, P.nodePrefix, P.chromeDir, `${P.repoRoot}/package.json`]);
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

describe("native command", () => {
  const cmd = nativeCommand({ ...P, node: "/Users/me/.nvm/versions/node/v22/bin/node", outFile: `${P.outDir}/out.mp4` });

  it("runs nice 10, then sandbox-exec with the profile, then env -i with only PATH, HOME and TMPDIR", () => {
    expect(cmd.command).toBe("/usr/bin/nice");
    expect(cmd.args.slice(0, 4)).toEqual(["-n", "10", "/usr/bin/sandbox-exec", "-p"]);
    expect(cmd.args[4]).toBe(buildSandboxProfile(P));
    expect(cmd.args.slice(5, 8)).toEqual(["/usr/bin/env", "-i", expect.stringMatching(/^PATH=/)]);
    const envs = cmd.args.filter((a) => /^[A-Z_]+=/.test(a) && !a.includes("\n"));
    expect(envs.map((e) => e.split("=")[0])).toEqual(["PATH", "HOME", "TMPDIR"]);
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
    expect(entry).toContain('const native = (mode === "--scale3d" || mode === "--scene3d" || mode === "--scene3d-stills") && extra.length === 1 && extra[0] === "--native";');
    expect(entry).toContain('(extra.length > 0 && !native)');
    expect(entry).toContain('((mode === "--scene3d" || mode === "--scene3d-stills") && !native)'); // the container can never be asked to draw a 3D scene or its preview pictures
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
