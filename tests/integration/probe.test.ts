import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildEngineConfig } from "@/server/core/engine-config";
import { evaluateQa } from "@/server/core/qa";
import { probeVideo, ProbeError } from "@/server/render/probe";
import { assertFfprobeAvailable } from "../support/tools";

const cfg = buildEngineConfig(new Map()).qa;
let root: string;
const f = (n: string) => path.join(root, n);
const ff = (...args: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "pipe" });
const sig = () => new AbortController().signal;
const opts = () => ({ storageRoot: root });

beforeAll(() => {
  assertFfprobeAvailable();
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "probe-")));
  const tone = ["-f", "lavfi", "-i", "sine=frequency=440:duration=20,volume=0.3"];
  // 20 s 1080x1920, tone, still colour: first and last frame identical.
  ff("-f", "lavfi", "-i", "color=c=blue:s=1080x1920:r=10:d=20", ...tone, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", f("good.mp4"));
  ff("-f", "lavfi", "-i", "color=c=blue:s=640x360:r=10:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", f("small-silent.mp4"));
  // black to white over 20 s: seam differs.
  ff("-f", "lavfi", "-i", "gradients=s=1080x1920:r=10:d=20:speed=0.5:c0=black:c1=white", ...tone, "-vf", "geq=lum='255*T/20':cb=128:cr=128", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", f("seam.mp4"));
  writeFileSync(f("corrupt.mp4"), Buffer.from("this is not a video"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("probeVideo", () => {
  it("good video passes with frames", async () => {
    const dir = f("attempt");
    const p = await probeVideo(f("good.mp4"), sig(), { ...opts(), attemptDir: dir });
    expect(p).toMatchObject({ width: 1080, height: 1920, hasAudio: true });
    expect(p.durationS).toBeCloseTo(20, 0);
    expect(p.loopDiff).toBeLessThan(2);
    expect(existsSync(path.join(dir, "review-first.png"))).toBe(true);
    expect(existsSync(path.join(dir, "review-last.png"))).toBe(true);
    expect(evaluateQa(p, cfg, { expectAudio: true, format: "short" }).pass).toBe(true);
  });

  it("wrong size and length fail, missing audio fails when expected", async () => {
    const p = await probeVideo(f("small-silent.mp4"), sig(), opts());
    expect(p.hasAudio).toBe(false);
    const r = evaluateQa(p, cfg, { expectAudio: true, format: "short" });
    expect(r.pass).toBe(false);
    expect(r.checks.filter((c) => !c.ok).map((c) => c.id)).toEqual(expect.arrayContaining(["size", "duration", "audio_present"]));
  });

  it("loop seam warns when first and last differ", async () => {
    const p = await probeVideo(f("seam.mp4"), sig(), opts());
    expect(p.loopDiff).toBeGreaterThan(cfg.loopDiffMax);
    const r = evaluateQa(p, cfg, { expectAudio: true, format: "short" });
    expect(r.checks.find((c) => c.id === "loop_seam")).toMatchObject({ ok: false, level: "warn" });
  });

  it("corrupt file raises a plain error", async () => {
    await expect(probeVideo(f("corrupt.mp4"), sig(), opts())).rejects.toThrow(new ProbeError("This file is not a readable video."));
  });

  it("refuses a path outside storage, including through a symlink", async () => {
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "probe-out-")));
    try {
      writeFileSync(path.join(outside, "x.mp4"), "x");
      await expect(probeVideo(path.join(outside, "x.mp4"), sig(), opts())).rejects.toThrow(/outside the storage/);
      execFileSync("ln", ["-s", path.join(outside, "x.mp4"), f("link.mp4")]);
      await expect(probeVideo(f("link.mp4"), sig(), opts())).rejects.toThrow(/outside the storage/);
      await expect(probeVideo(path.join(root, "..", path.basename(outside), "x.mp4"), sig(), opts())).rejects.toThrow(/outside the storage/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("times out on a hanging ffprobe", async () => {
    const bin = f("hang.sh");
    writeFileSync(bin, "#!/bin/sh\nexec sleep 30\n");
    chmodSync(bin, 0o755);
    const t = Date.now();
    await expect(probeVideo(f("good.mp4"), sig(), { ...opts(), ffprobeBin: bin, timeoutMs: 500 })).rejects.toThrow(/timed out/);
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it("has no secrets in its environment", async () => {
    const bin = f("env.sh");
    const dump = f("env.out");
    mkdirSync(path.dirname(dump), { recursive: true });
    writeFileSync(bin, `#!/bin/sh\nenv > "${dump}"\nexit 1\n`);
    chmodSync(bin, 0o755);
    const env = { ...process.env, DATABASE_URL: "postgres://secret", VAULT_KEY: "topsecret", ANTHROPIC_API_KEY: "sk-x" };
    await expect(probeVideo(f("good.mp4"), sig(), { ...opts(), ffprobeBin: bin, env })).rejects.toThrow();
    const seen = execFileSync("cat", [dump], { encoding: "utf8" });
    expect(seen).not.toMatch(/secret|sk-x|DATABASE_URL|VAULT_KEY|ANTHROPIC/);
    expect(seen).toMatch(/^PATH=/m);
  });
});
