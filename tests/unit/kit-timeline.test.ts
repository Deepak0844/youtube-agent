import { describe, expect, it } from "vitest";
import { breakLines, collageStarts, currentWord, docFrames, mediaOf, msToFrame, paginate, sceneRange } from "../../remotion/kit/timeline";

const m = (t: string) => t.length * 10;

describe("frames", () => {
  it("converts ms to frames", () => {
    expect(msToFrame(1000, 30)).toBe(30);
    expect(msToFrame(500, 30)).toBe(15);
    expect(msToFrame(33, 30)).toBe(1);
  });
  it("places scenes and sizes the video by the latest end", () => {
    expect(sceneRange({ startMs: 2000, durationMs: 1000 }, 30)).toEqual({ from: 60, duration: 30 });
    expect(sceneRange({ startMs: 0, durationMs: 1 }, 30).duration).toBe(1);
    expect(docFrames([{ startMs: 0, durationMs: 2000 }, { startMs: 3000, durationMs: 1000 }], 30)).toBe(120);
  });
  it("tells clips from pictures", () => {
    expect(mediaOf("/a/b.MP4")).toBe("video");
    expect(mediaOf("data:image/svg+xml;utf8,<svg/>")).toBe("image");
  });
  it("staggers collage tiles", () => {
    expect(collageStarts([300, 300, 0], 30)).toEqual([0, 21, 33]);
  });
});

describe("currentWord", () => {
  const w = [{ word: "a", startS: 0, endS: 0.5 }, { word: "b", startS: 0.6, endS: 1 }];
  it("finds the spoken word, holds briefly in gaps, then none", () => {
    expect(currentWord(w, 0.2)).toBe(0);
    expect(currentWord(w, 0.55)).toBe(0);
    expect(currentWord(w, 0.7)).toBe(1);
    expect(currentWord(w, 1.3)).toBe(1);
    expect(currentWord(w, 1.5)).toBe(-1);
    expect(currentWord(w, -1)).toBe(-1);
  });
});

describe("line breaking", () => {
  const words = ["aaa", "bbb", "ccc", "ddd", "eee"];
  it("breaks by width", () => {
    expect(breakLines(words, 75, m)).toEqual([[0, 1], [2, 3], [4]]);
  });
  it("gives a too-long word its own line", () => {
    expect(breakLines(["x", "longlonglong", "y"], 50, m)).toEqual([[0], [1], [2]]);
  });
  it("pages at most maxLines lines", () => {
    expect(paginate(words, 75, m, 2)).toEqual([[[0, 1], [2, 3]], [[4]]]);
  });
  it("handles no words", () => {
    expect(paginate([], 75, m, 2)).toEqual([]);
  });
});
