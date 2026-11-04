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

  it("denies the network and only lets loopback through", () => {
    expect(profile).toContain("(deny network*)");
    const allows = lines(profile).filter((l) => l.startsWith("(allow network"));
    expect(allows).toEqual(['(allow network* (local ip "localhost:*") (remote ip "localhost:*"))']);
    expect(profile.indexOf("(deny network*)")).toBeLessThan(profile.indexOf("(allow network*"));
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

  it("refuses an output file outside the out folder and a relative node", () => {
    expect(() => nativeCommand({ ...P, node: "/n/node", outFile: "/tmp/out.mp4" })).toThrow(KnownFailure);
    expect(() => nativeCommand({ ...P, node: "node", outFile: `${P.outDir}/out.mp4` })).toThrow(KnownFailure);
  });
});

describe("the gl override and the container", () => {
  const entry = readFileSync("remotion/kit/render-entry.mjs", "utf8");

  it("render-entry honours native (angle gl, concurrency 1) only for --scale3d with exactly --native", () => {
    expect(entry).toContain('const native = mode === "--scale3d" && extra.length === 1 && extra[0] === "--native";');
    expect(entry).toContain('(extra.length > 0 && !native)');
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
