import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cutClipArgs } from "@/server/core/clip-cut";
import { buildEngineConfig } from "@/server/core/engine-config";
import type { StageContext } from "@/server/core/stage-handler";
import { renderClip } from "@/server/providers/renderer/clip-render";
import type { TsxRendererDeps } from "@/server/providers/renderer/tsx-render";
import { probeVideo } from "@/server/render/probe";
import { RENDER_IMAGE } from "@/server/render/runner";
import { runChild } from "@/server/render/child";
import { renderKitDir } from "@/worker/handlers";
import { assertDockerUp } from "../support/infra";
import { assertFfprobeAvailable } from "../support/tools";

// Clip Factory CF2b: a cut, reframed clip gets the app's captions in the locked render container (render-entry.mjs --clip).
const run = promisify(execFile);
let root: string;
beforeAll(async () => {
  assertFfprobeAvailable();
  await assertDockerUp();
  await run("docker", ["image", "inspect", RENDER_IMAGE]).catch(async () => {
    await run("docker", ["build", "-f", "infra/Dockerfile.render", "-t", RENDER_IMAGE, "."], { timeout: 1_500_000, maxBuffer: 64 << 20 });
  });
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "clip-render-")));
}, 1_600_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const deps: TsxRendererDeps = { kitDir: renderKitDir(), runChild: (spec) => runChild(spec), probe: (file, signal) => probeVideo(file, signal, { storageRoot: root }) };
const ctx = (name: string): StageContext => {
  const attemptDir = path.join(root, name);
  rmSync(attemptDir, { recursive: true, force: true });
  mkdirSync(attemptDir, { recursive: true });
  return { stage: { name: "clip", videoId: "v" }, claim: { stageRunId: `clip-${name}`, fence: 1, workerId: "t" }, config: buildEngineConfig(new Map()), signal: new AbortController().signal, attemptDir, log: () => undefined } as unknown as StageContext;
};
const words = "Light from the sun looks white but it is really every colour".split(" ").map((word, i) => ({ word, startS: 0.2 + i * 0.25, endS: 0.2 + i * 0.25 + 0.2 }));

/** A 6 s black landscape source with a tone, cut and reframed by the CF2a cutter into a 3 s portrait clip. */
function blackClip(): string {
  const src = path.join(root, "src.mp4");
  const clip = path.join(root, "clip.mp4");
  const a = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=640x360:r=30:d=6", "-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-shortest", "-pix_fmt", "yuv420p", src]);
  expect(a.status).toBe(0);
  const b = spawnSync("ffmpeg", cutClipArgs({ inFile: src, outFile: clip, startS: 1, endS: 4 }));
  expect(b.status, String(b.stderr)).toBe(0);
  return clip;
}

describe("clip captions through the locked renderer", () => {
  it("draws the captions over the clip, keeps its sound and the 1080x1920 size", async () => {
    const clip = blackClip();
    const c = ctx("ok");
    const r = await renderClip(deps, c, { clipFile: clip, captions: words, style: null, durationS: 3, outFile: "captioned.mp4" });
    if (!r.ok) throw new Error(r.message);
    const p = await probeVideo(r.outPath, new AbortController().signal, { storageRoot: root });
    expect([p.width, p.height]).toEqual([1080, 1920]);
    expect(p.hasAudio).toBe(true);
    expect(Math.abs(p.durationS - 3)).toBeLessThan(0.5);
    // the source is all black, so any light pixel is a caption: it must sit in the lower band and nowhere in the upper part
    const still = path.join(c.attemptDir, "still.png");
    const f = spawnSync("ffmpeg", ["-v", "error", "-y", "-ss", "1.0", "-i", r.outPath, "-frames:v", "1", still]);
    expect(f.status).toBe(0);
    const png = PNG.sync.read(readFileSync(still));
    let upper = 0;
    let lower = 0;
    for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      if (png.data[i]! > 180 && png.data[i + 1]! > 180 && png.data[i + 2]! > 180) {
        if (y < 1400) upper++;
        else lower++;
      }
    }
    expect(upper).toBe(0);
    expect(lower).toBeGreaterThan(300);
  }, 600_000);

  it("renders a 25 s full-resolution, detailed clip without the container being killed for memory (a real clip did exit 137)", async () => {
    // A 6 s black clip never showed it; a real 24 s clip of an engine video was killed at the 4 GB limit before the render-entry limits.
    const big = path.join(root, "big.mp4");
    const g = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=30:duration=25", "-f", "lavfi", "-i", "sine=frequency=300:duration=25", "-shortest", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", big]);
    expect(g.status).toBe(0);
    const r = await renderClip(deps, ctx("big"), { clipFile: big, captions: words, style: null, durationS: 25, outFile: "big-out.mp4" });
    if (!r.ok) throw new Error(r.message);
    const p = await probeVideo(r.outPath, new AbortController().signal, { storageRoot: root });
    expect([p.width, p.height]).toEqual([1080, 1920]);
    expect(Math.abs(p.durationS - 25)).toBeLessThan(0.7);
  }, 600_000);

  it("refuses in plain words: a missing clip file, a clip over 180 s, a bad output name", async () => {
    const c = ctx("bad");
    expect(await renderClip(deps, c, { clipFile: path.join(root, "nope.mp4"), captions: [], durationS: 3, outFile: "x.mp4" })).toMatchObject({ ok: false });
    expect(await renderClip(deps, c, { clipFile: blackClip(), captions: [], durationS: 181, outFile: "x.mp4" })).toMatchObject({ ok: false, message: expect.stringMatching(/180 seconds/) });
    expect(await renderClip(deps, c, { clipFile: blackClip(), captions: [], durationS: 0, outFile: "x.mp4" })).toMatchObject({ ok: false });
    await expect(renderClip(deps, c, { clipFile: blackClip(), captions: [], durationS: 3, outFile: "../x.mp4" })).rejects.toThrow(/plain file name/);
  }, 120_000);

  it("a clip that is not a video is refused by the render, not trusted", async () => {
    const bad = path.join(root, "bad.mp4");
    writeFileSync(bad, "not a video");
    const r = await renderClip(deps, ctx("notvideo"), { clipFile: bad, captions: words, durationS: 3, outFile: "x.mp4" });
    expect(r.ok).toBe(false);
  }, 600_000);
});
