import { execFile } from "node:child_process";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerDeps } from "../../infra/render-runner/docker";
import { createRunnerServer } from "../../infra/render-runner/server";
import { buildEngineConfig } from "@/server/core/engine-config";
import type { StageContext } from "@/server/core/stage-handler";
import { createHttpRunner } from "@/server/providers/renderer/container-runner";
import { createContainerRenderer } from "@/server/providers/renderer/remotion-container";
import { probeVideo } from "@/server/render/probe";
import { RENDER_IMAGE } from "@/server/render/runner";
import { removeStorageRoot } from "../support/storage";

// The render service for real: real docker, the real render image, the real kit render, through the HTTP client the worker uses.
// Skips cleanly when Docker or the image is not there.
const run = promisify(execFile);
const ready = await run("docker", ["image", "inspect", RENDER_IMAGE]).then(() => true, () => false);

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ytstudio-rrun-")));
const TOKEN = "i".repeat(32);
let server: Server;
let url = "";
afterAll(async () => {
  server?.closeAllConnections?.();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  removeStorageRoot(root);
});

beforeAll(async () => {
  if (!ready) return;
  // Same machine, same path: the service's data root and the daemon's host path are the same folder here.
  server = createRunnerServer({ ...dockerDeps({ token: TOKEN, root, hostRoot: root, image: RENDER_IMAGE }), cleanupDelayMs: 200 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

const runner = () => createHttpRunner({ url, token: TOKEN, storageRoot: root });
const leftovers = async (id: string) => (await run("docker", ["ps", "-aq", "--filter", `name=ytstudio-render-${id}-`])).stdout.trim();

function setup(id: string, settings: [string, unknown][] = [], signal = new AbortController().signal) {
  const attemptDir = path.join(root, "videos", id, "attempt-1");
  mkdirSync(attemptDir, { recursive: true });
  mkdirSync(path.join(root, "assets", "j1"), { recursive: true });
  copyFileSync("tests/fixtures/assets/plain.png", path.join(root, "assets", "j1", "main.png"));
  copyFileSync("tests/fixtures/assets/tone.wav", path.join(root, "videos", id, "narration.wav"));
  const progress: number[] = [];
  const ctx = {
    stage: { name: "render", videoId: id }, claim: { stageRunId: id, fence: 1 }, config: buildEngineConfig(new Map(settings)), signal, attemptDir,
    log: () => undefined, progress: (p: number) => progress.push(p), nextStep: () => 0, paid: async () => { throw new Error("no paid calls"); },
  } as unknown as StageContext;
  const renderer = createContainerRenderer({
    root, runner: runner(), workerId: "w-it", assetFile: async (a) => (a === "img1" ? "assets/j1/main.png" : null),
    probe: (f, s) => probeVideo(f, s, { storageRoot: root }),
  });
  const doc = { version: 1, scenes: [
    { id: "s1", beat: "b1", kind: "terminal", startMs: 0, durationMs: 1000, lines: [{ text: "ls" }] },
    { id: "s2", beat: "b2", kind: "story_kenburns", startMs: 1000, durationMs: 1000, image: "img1" },
  ] } as never;
  const args = { sceneFile: "x", doc, audioFile: path.join(root, "videos", id, "narration.wav"), captions: [{ word: "hi", startS: 0, endS: 0.5 }], outFile: "render.mp4", size: { width: 1080, height: 1920 } };
  return { ctx, renderer, args, attemptDir, progress };
}

describe.skipIf(!ready)("the render service, for real", () => {
  it("renders a 2-scene doc to a 1080x1920 mp4 with sound, reports progress, and leaves no container", async () => {
    const id = `rr-ok-${process.pid}`;
    const { ctx, renderer, args, attemptDir, progress } = setup(id);
    const r = await renderer.render(ctx, args);
    expect(r.outPath).toBe(path.join(attemptDir, "render.mp4"));
    expect(r.image).toMatch(/^sha256:[0-9a-f]{64}$/); // the service pinned the image by id
    const p = await probeVideo(r.outPath, new AbortController().signal, { storageRoot: root });
    expect(p).toMatchObject({ width: 1080, height: 1920, hasAudio: true });
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)).toBe(100);
    await new Promise((res) => setTimeout(res, 500)); // the service's second clean-up
    expect(await leftovers(id)).toBe("");
  }, 300_000);

  it("a render over its time limit is stopped by the service and its container removed", async () => {
    const id = `rr-slow-${process.pid}`;
    const { ctx, renderer, args } = setup(id, [["render.timeout_s", 1]]);
    await expect(renderer.render(ctx, args)).rejects.toThrow(/1 min limit/);
    await new Promise((res) => setTimeout(res, 500));
    expect(await leftovers(id)).toBe("");
  }, 120_000);

  it("aborting the stage stops the render within seconds and leaves no container", async () => {
    const id = `rr-abort-${process.pid}`;
    const ac = new AbortController();
    const { ctx, renderer, args, progress } = setup(id, [], ac.signal);
    const p = renderer.render(ctx, args).catch((e: unknown) => e);
    const t0 = Date.now();
    while (progress.length === 0 && Date.now() - t0 < 120_000) await new Promise((res) => setTimeout(res, 100)); // the container is running
    expect(await leftovers(id)).not.toBe("");
    ac.abort();
    await p;
    const t1 = Date.now();
    while ((await leftovers(id)) !== "" && Date.now() - t1 < 10_000) await new Promise((res) => setTimeout(res, 250));
    expect(await leftovers(id)).toBe("");
    expect(Date.now() - t1).toBeLessThan(10_000);
  }, 300_000);

  it("a folder that is a symlink to outside the data root is refused and no container is started", async () => {
    const id = `rr-link-${process.pid}`;
    const attempt = path.join(root, "videos", id, "attempt-1");
    mkdirSync(path.join(attempt, "render-out"), { recursive: true });
    symlinkSync("/etc", path.join(attempt, "render-in"));
    const { ctx } = setup(`${id}-x`);
    const e = await runner().run(ctx, {
      kind: "kit", name: `ytstudio-render-${id}-aaaa1111`, inDir: path.join(attempt, "render-in"), outDir: path.join(attempt, "render-out"),
      config: { timeoutS: 60, cpus: 1, memoryMb: 512, pids: 128 },
    }).catch((x: unknown) => x);
    expect((e as Error).message).toBe("The render service refused the job.");
    expect(await leftovers(id)).toBe("");
  });

  it("info reports Docker and the pinned image; list and remove see only render containers", async () => {
    const r = runner();
    const info = await r.info();
    expect(info.dockerVersion).toMatch(/^\d+\.\d+/);
    expect(info.image.pinned).toBe(true);
    expect(await r.list()).toEqual(expect.any(Array));
    await expect(r.remove("postgres")).rejects.toThrow("not a render container");
  });
});
