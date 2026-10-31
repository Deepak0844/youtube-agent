import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { buildEngineConfig } from "@/server/core/engine-config";
import type { StageContext } from "@/server/core/stage-handler";
import { createContainerRenderer } from "@/server/providers/renderer/remotion-container";
import { runChild } from "@/server/render/child";
import { probeVideo } from "@/server/render/probe";
import { RENDER_IMAGE } from "@/server/render/runner";
import { removeStorageRoot } from "../support/storage";

// The real render image, real docker, real ffprobe. Skips cleanly when Docker or the image is not there.
const run = promisify(execFile);
const ready = await run("docker", ["image", "inspect", RENDER_IMAGE]).then(() => true, () => false);

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ytstudio-rstage-")));
afterAll(() => removeStorageRoot(root));

function setup(id: string, settings: [string, unknown][] = []) {
  const attemptDir = path.join(root, "videos", id, "attempt-1");
  mkdirSync(attemptDir, { recursive: true });
  mkdirSync(path.join(root, "assets", "j1"), { recursive: true });
  copyFileSync("tests/fixtures/assets/plain.png", path.join(root, "assets", "j1", "main.png"));
  copyFileSync("tests/fixtures/assets/tone.wav", path.join(root, "videos", id, "narration.wav"));
  const ctx = {
    stage: { name: "render", videoId: id }, claim: { stageRunId: id, fence: 1 }, config: buildEngineConfig(new Map(settings)), signal: new AbortController().signal, attemptDir,
    log: () => undefined, nextStep: () => 0, paid: async () => { throw new Error("no paid calls"); },
  } as unknown as StageContext;
  const renderer = createContainerRenderer({
    root, kitDir: path.resolve("remotion/kit"), runChild: (s) => runChild(s), assetFile: async (a) => (a === "img1" ? "assets/j1/main.png" : null),
    probe: (f, s) => probeVideo(f, s, { storageRoot: root }),
  });
  const doc = { version: 1, scenes: [
    { id: "s1", beat: "b1", kind: "terminal", startMs: 0, durationMs: 1000, lines: [{ text: "ls" }] },
    { id: "s2", beat: "b2", kind: "story_kenburns", startMs: 1000, durationMs: 1000, image: "img1" },
  ] } as never;
  const args = { sceneFile: "x", doc, audioFile: path.join(root, "videos", id, "narration.wav"), captions: [{ word: "hi", startS: 0, endS: 0.5 }], outFile: "render.mp4", size: { width: 1080, height: 1920 } };
  return { ctx, renderer, args, attemptDir };
}

const leftovers = async (id: string) => (await run("docker", ["ps", "-aq", "--filter", `name=ytstudio-render-${id}-`])).stdout.trim();

describe.skipIf(!ready)("render stage in the real container", () => {
  it("renders a 2-scene doc to a 1080x1920 mp4 with sound and leaves no container", async () => {
    const id = `rs-ok-${process.pid}`;
    const { ctx, renderer, args, attemptDir } = setup(id);
    const r = await renderer.render(ctx, args);
    expect(r.outPath).toBe(path.join(attemptDir, "render.mp4"));
    const p = await probeVideo(r.outPath, new AbortController().signal, { storageRoot: root });
    expect(p).toMatchObject({ width: 1080, height: 1920, hasAudio: true });
    expect(p.durationS).toBeGreaterThan(1.5);
    expect(await leftovers(id)).toBe("");
  }, 300_000);

  it("a render over the time limit is stopped and its container removed", async () => {
    const id = `rs-slow-${process.pid}`;
    const { ctx, renderer, args } = setup(id, [["render.timeout_s", 1]]);
    await expect(renderer.render(ctx, args)).rejects.toThrow(/1 min limit/);
    expect(await leftovers(id)).toBe("");
  }, 120_000);
});
