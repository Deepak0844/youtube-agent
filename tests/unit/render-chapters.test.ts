import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chapterFrameChunks } from "@/server/core/long-form";
import { KnownFailure } from "@/server/core/paid-call";
import type { StageContext } from "@/server/core/stage-handler";
import type { Renderer, RenderArgs } from "@/server/providers/renderer";
import type { ChildSpec } from "@/server/render/child";
import type { MixDeps } from "@/server/render/mix";
import { renderInChapters } from "@/worker/stages/render";

let dir: string;
let logs: string[];
let listText: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "chapters-"));
  logs = [];
  listText = undefined;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ctx = () => ({ attemptDir: dir, log: (l: string) => logs.push(l), signal: new AbortController().signal, claim: { stageRunId: "run1" } }) as unknown as StageContext;
const args = { sceneFile: "s", outFile: "render.mp4", size: { width: 1920, height: 1080 }, layout: "landscape" } as RenderArgs;
const chunks = chapterFrameChunks([{ startMs: 0 }, { startMs: 100_000 }, { startMs: 250_000 }], 30);

/** A renderer that writes a tiny file per call and records what it was asked. */
function renderer(over: { failAt?: number; where?: string; image?: string } = {}): Renderer & { asked: RenderArgs[] } {
  const asked: RenderArgs[] = [];
  return {
    asked,
    async render(c, a) {
      asked.push(a);
      if (over.failAt === asked.length) throw new KnownFailure("chapter drawing failed");
      writeFileSync(path.join(c.attemptDir, a.outFile), "x");
      return { outPath: over.where ? path.join(over.where, a.outFile) : path.join(c.attemptDir, a.outFile), image: over.image ?? "img1" };
    },
  } as Renderer & { asked: RenderArgs[] };
}

/** ffmpeg concat writes the joined file; ffprobe says the joined length. */
const mix = (durationS: number, fail = false): MixDeps => ({
  audioRoot: dir,
  async runChild(spec: ChildSpec) {
    if (spec.command === "ffmpeg") {
      if (fail) return { code: 1, signal: null, truncated: false, timedOut: false, aborted: false };
      listText = readFileSync(path.join(dir, "chapters.txt"), "utf8");
      writeFileSync(spec.args[spec.args.length - 1]!, "joined");
    } else spec.onLine?.(String(durationS));
    return { code: 0, signal: null, truncated: false, timedOut: false, aborted: false };
  },
});

describe("renderInChapters", () => {
  it("draws every chapter as its own frame range, joins them in order, and leaves only render.mp4", async () => {
    const r = renderer();
    const out = await renderInChapters(r, mix(360), ctx(), args, chunks, 360);
    expect(r.asked.map((a) => [a.outFile, a.chunk])).toEqual([["chapter-01.mp4", { from: 0, to: 2999 }], ["chapter-02.mp4", { from: 3000, to: 7499 }], ["chapter-03.mp4", { from: 7500, to: "end" }]]);
    expect(listText).toBe("file 'chapter-01.mp4'\nfile 'chapter-02.mp4'\nfile 'chapter-03.mp4'\n");
    expect(readdirSync(dir)).toEqual(["render.mp4"]);
    expect(out).toEqual({ chunks: 3, image: "img1" });
    expect(logs).toEqual(["render: chapter 1 of 3", "render: chapter 2 of 3", "render: chapter 3 of 3"]);
  });

  it("a chapter that fails stops the stage and removes the clips already drawn", async () => {
    await expect(renderInChapters(renderer({ failAt: 2 }), mix(360), ctx(), args, chunks, 360)).rejects.toThrow(/chapter drawing failed/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("a joined video of the wrong length (a chapter missing or twice) is refused and nothing is kept", async () => {
    await expect(renderInChapters(renderer(), mix(300), ctx(), args, chunks, 360)).rejects.toThrow(/joined video is 300\.0 s but the scenes add up to 360\.0 s/);
    expect(readdirSync(dir)).toEqual([]);
    expect(existsSync(path.join(dir, "render.mp4"))).toBe(false);
  });

  it("a failed join is a plain failure that names no path, and the clips are removed", async () => {
    const e = await renderInChapters(renderer(), mix(360, true), ctx(), args, chunks, 360).then(() => null, (x: unknown) => x as Error);
    expect(e).toBeInstanceOf(KnownFailure);
    expect(e?.message).toBe("Joining the chapters failed (ffmpeg returned an error).");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses a renderer that wrote outside the attempt folder", async () => {
    await expect(renderInChapters(renderer({ where: tmpdir() }), mix(360), ctx(), args, chunks, 360)).rejects.toThrow(/outside its attempt folder/);
  });

  describe("with a chapter cache", () => {
    let cache: string;
    beforeEach(() => { cache = path.join(mkdtempSync(path.join(tmpdir(), "cache-")), "chapter-cache"); });
    const files = () => (existsSync(cache) ? readdirSync(cache).sort() : []);

    it("a retry after a failed chapter draws only the missing chapters, and success removes the cache", async () => {
      await expect(renderInChapters(renderer({ failAt: 3 }), mix(360), ctx(), args, chunks, 360, cache)).rejects.toThrow(/chapter drawing failed/);
      expect(files().filter((f) => f.endsWith(".mp4"))).toHaveLength(2); // chapters 1 and 2 were kept
      expect(readdirSync(dir)).toEqual([]);
      const r = renderer();
      logs = [];
      const out = await renderInChapters(r, mix(360), ctx(), args, chunks, 360, cache);
      expect(r.asked.map((a) => a.outFile)).toEqual(["chapter-03.mp4"]);
      expect(out).toEqual({ chunks: 3, image: "img1", reused: 2 });
      expect(listText).toBe("file 'chapter-01.mp4'\nfile 'chapter-02.mp4'\nfile 'chapter-03.mp4'\n");
      expect(logs[0]).toBe("render: chapter 1 of 3 reused from an earlier attempt");
      expect(existsSync(cache)).toBe(false);
      expect(readdirSync(dir)).toEqual(["render.mp4"]);
    });

    it("changed scenes do not reuse an old clip", async () => {
      await expect(renderInChapters(renderer({ failAt: 3 }), mix(360), ctx(), args, chunks, 360, cache)).rejects.toThrow();
      const r = renderer();
      await renderInChapters(r, mix(360), ctx(), { ...args, style: "other" }, chunks, 360, cache);
      expect(r.asked).toHaveLength(3);
    });

    it("a clip drawn by another render image is drawn again, so one video has one image", async () => {
      await expect(renderInChapters(renderer({ failAt: 3, image: "old" }), mix(360), ctx(), args, chunks, 360, cache)).rejects.toThrow();
      const r = renderer({ image: "new" });
      const out = await renderInChapters(r, mix(360), ctx(), args, chunks, 360, cache);
      expect(r.asked.map((a) => a.outFile)).toEqual(["chapter-03.mp4", "chapter-01.mp4", "chapter-02.mp4"]);
      expect(out).toEqual({ chunks: 3, image: "new" });
    });

    it("a joined video of the wrong length empties the cache, so the next attempt draws everything", async () => {
      await expect(renderInChapters(renderer(), mix(300), ctx(), args, chunks, 360, cache)).rejects.toThrow(/joined video is 300\.0 s/);
      expect(existsSync(cache)).toBe(false);
    });

    it("a half-written clip (temp name only) is never reused", async () => {
      await expect(renderInChapters(renderer({ failAt: 2 }), mix(360), ctx(), args, chunks, 360, cache)).rejects.toThrow();
      const kept = files().find((f) => f.endsWith(".mp4"))!;
      rmSync(path.join(cache, kept));
      writeFileSync(path.join(cache, `${kept}.tmp`), "partial");
      const r = renderer();
      await renderInChapters(r, mix(360), ctx(), args, chunks, 360, cache);
      expect(r.asked).toHaveLength(3);
    });
  });
});
