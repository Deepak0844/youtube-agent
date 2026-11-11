import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderGrid } from "@/server/render/bakeoff";
import { probeVideo } from "@/server/render/probe";
import { assertFfprobeAvailable } from "../support/tools";

// A real ffmpeg run over the repo's fixture clips: the grid is one video with the panels side by side.
let dir: string;
const good = path.resolve("tests/fixtures/video/good.mp4");
const short = path.resolve("tests/fixtures/video/short.mp4");
beforeAll(async () => {
  await assertFfprobeAvailable();
  dir = mkdtempSync(path.join(tmpdir(), "bakeoff-test-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("renderGrid (real ffmpeg)", () => {
  it("writes one video with two panels side by side, and nothing else", async () => {
    const out = path.join(dir, "grid.mp4");
    const r = await renderGrid([{ file: good, label: "Model A", costMicroUsd: 420_000 }, { file: short, label: "Model B", costMicroUsd: null }], out);
    expect(r).toEqual({ ok: true });
    expect(statSync(out).size).toBeGreaterThan(1000);
    const info = await probeVideo(out, new AbortController().signal, { storageRoot: dir });
    expect(info).toMatchObject({ width: 720, height: 640 });
  }, 120_000);
  it("four panels make a 2 by 2 grid", async () => {
    const out = path.join(dir, "grid4.mp4");
    const clips = ["A", "B", "C", "D"].map((l) => ({ file: good, label: `Model ${l}`, costMicroUsd: 100_000 }));
    expect(await renderGrid(clips, out)).toEqual({ ok: true });
    expect(await probeVideo(out, new AbortController().signal, { storageRoot: dir })).toMatchObject({ width: 720, height: 1280 });
  }, 120_000);
  it("says why instead of running when the panels are not allowed, and a missing clip fails cleanly", async () => {
    expect(await renderGrid([{ file: good, label: "Only one", costMicroUsd: 1 }], path.join(dir, "x.mp4"))).toMatchObject({ ok: false, message: expect.stringMatching(/at least 2/) });
    const r = await renderGrid([{ file: path.join(dir, "missing.mp4"), label: "A", costMicroUsd: 1 }, { file: good, label: "B", costMicroUsd: 1 }], path.join(dir, "y.mp4"));
    expect(r.ok).toBe(false);
  }, 120_000);
});
