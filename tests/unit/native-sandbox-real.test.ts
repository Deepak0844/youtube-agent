import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildSandboxProfile, SANDBOX_EXEC } from "@/server/providers/renderer/native-sandbox";

// The GENERATED profile, really applied by macOS sandbox-exec to a tiny node script. Skipped anywhere else (CI is Linux).
const can = process.platform === "darwin" && existsSync(SANDBOX_EXEC);

const PROBE = `
import net from "node:net";
import fs from "node:fs";
const [port, outDir, tmpDir, outside, home, env] = process.argv.slice(2);
const conn = (host, p) => new Promise((res) => {
  const s = net.connect({ host, port: Number(p), timeout: 3000 });
  s.on("connect", () => { s.destroy(); res("connected"); });
  s.on("error", (e) => res(e.code));
  s.on("timeout", () => { s.destroy(); res("timeout"); });
});
const attempt = (f) => { try { f(); return "ok"; } catch (e) { return e.code; } };
const r = {
  loopback: await conn("127.0.0.1", port),
  egress: await conn("1.1.1.1", "80"),
  readHome: attempt(() => fs.readFileSync(home)),
  readEnv: attempt(() => fs.readFileSync(env)),
  writeOutside: attempt(() => fs.writeFileSync(outside, "x")),
  writeOut: attempt(() => fs.writeFileSync(outDir + "/a.txt", "x")),
  writeTmp: attempt(() => fs.writeFileSync(tmpDir + "/a.txt", "x")),
};
console.log(JSON.stringify(r));
`;

const root = can ? realpathSync(mkdtempSync(path.join(tmpdir(), "nsr-"))) : "";
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!can)("generated sandbox profile, applied for real", () => {
  it("allows loopback and writes to out/tmp only; denies egress, reading home and a repo file (tsconfig.json; .env.local is under the same repo deny but may not exist), and writes elsewhere", async () => {
    const { createServer } = await import("node:net");
    const inDir = path.join(root, "in");
    const outDir = path.join(root, "out");
    const tmpDir = path.join(root, "tmp");
    for (const d of [inDir, outDir, tmpDir]) mkdirSync(d, { recursive: true });
    writeFileSync(path.join(inDir, "probe.mjs"), PROBE);
    const repoRoot = realpathSync(process.cwd());
    const node = realpathSync(process.execPath);
    const profile = buildSandboxProfile({
      repoRoot, kitDir: path.join(repoRoot, "remotion", "kit"), nodeModules: path.join(repoRoot, "node_modules"), storageRoot: root, homeDir: realpathSync(homedir()),
      inDir, outDir, tmpDir, nodePrefix: path.dirname(path.dirname(node)), chromeDir: path.join(root, "chrome"),
    });
    const server = createServer((c) => { c.on("error", () => undefined); c.end("x"); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as { port: number }).port;
      const out = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
        // async spawn so this process's own loopback server can answer
        import("node:child_process").then(({ spawn }) => {
          const c = spawn(SANDBOX_EXEC, ["-p", profile, node, path.join(inDir, "probe.mjs"), String(port), outDir, tmpDir, path.join(root, "outside.txt"), path.join(realpathSync(homedir()), ".zshrc"), path.join(repoRoot, "tsconfig.json")], { stdio: ["ignore", "pipe", "pipe"] });
          let stdout = "";
          let stderr = "";
          c.stdout.on("data", (d) => (stdout += d));
          c.stderr.on("data", (d) => (stderr += d));
          c.on("close", (status) => resolve({ status, stdout, stderr }));
        });
      });
      expect(out.status, out.stderr).toBe(0);
      expect(JSON.parse(out.stdout.trim())).toEqual({
        loopback: "connected",
        egress: "EPERM",
        readHome: "EPERM",
        readEnv: "EPERM",
        writeOutside: "EPERM",
        writeOut: "ok",
        writeTmp: "ok",
      });
      expect(readFileSync(path.join(outDir, "a.txt"), "utf8")).toBe("x");
      expect(existsSync(path.join(root, "outside.txt"))).toBe(false);
    } finally {
      server.close();
    }
  }, 30_000);

  it("node starts with its working directory in the allowed temp folder UNDER the read-denied storage root; the denied attempt folder fails with EPERM (uv_cwd)", () => {
    // storage root (denied) > attempt dir (denied, not itself allowed) > native-tmp (allowed): the real layout of a job
    const storage = path.join(root, "cwd-storage");
    const attempt = path.join(storage, "att");
    const [inDir, outDir, tmpDir] = ["native-in", "native-out", "native-tmp"].map((n) => path.join(attempt, n));
    for (const d of [inDir!, outDir!, tmpDir!]) mkdirSync(d, { recursive: true });
    const repoRoot = realpathSync(process.cwd());
    const node = realpathSync(process.execPath);
    const profile = buildSandboxProfile({
      repoRoot, kitDir: path.join(repoRoot, "remotion", "kit"), nodeModules: path.join(repoRoot, "node_modules"), storageRoot: storage, homeDir: realpathSync(homedir()),
      inDir: inDir!, outDir: outDir!, tmpDir: tmpDir!, nodePrefix: path.dirname(path.dirname(node)), chromeDir: path.join(root, "chrome"),
    });
    const cwdOf = (cwd: string) => spawnSync(SANDBOX_EXEC, ["-p", profile, node, "-e", 'try { console.log(process.cwd()); } catch (e) { console.log(e.code); }'], { cwd, encoding: "utf8" });
    expect(cwdOf(tmpDir!).stdout.trim()).toBe(tmpDir);
    expect(cwdOf(inDir!).stdout.trim()).toBe(inDir);
    expect(cwdOf(attempt).stdout.trim()).toBe("EPERM"); // negative control: the old cwd
  }, 30_000);

  it("the sandbox program itself is the one the renderer uses", () => {
    expect(spawnSync(SANDBOX_EXEC, ["-p", "(version 1)(allow default)", "/usr/bin/true"]).status).toBe(0);
  });
});
