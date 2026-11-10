import { describe, expect, it } from "vitest";
import { chapterMarks, chapterFrameChunks, chapterMarksFromScenes, chapterTimestampLines, clock, lengthRangeProblem, lengthVsQaProblem, longWordRange, outlineEstimate, validateOutline } from "@/server/core/long-form";

const ch = (title: string, target_s: number) => ({ title, line: `about ${title}`, target_s });
const good = { chapters: [ch("Hook", 90), ch("How it works", 150), ch("Why it matters", 120)] }; // 360 s = 6 min

describe("lengthRangeProblem", () => {
  it("accepts the default 3 to 8 within a 15 minute setting", () => expect(lengthRangeProblem(3, 8, 15)).toBeNull());
  it("refuses a longest length above the max setting", () => expect(lengthRangeProblem(3, 16, 15)).toMatch(/at most|longest length is 15/i));
  it("refuses min above max, under 3 minutes and fractions", () => {
    expect(lengthRangeProblem(9, 8, 15)).not.toBeNull();
    expect(lengthRangeProblem(2, 8, 15)).not.toBeNull();
    expect(lengthRangeProblem(3.5, 8, 15)).not.toBeNull();
    expect(lengthRangeProblem("3", 8, 15)).not.toBeNull();
  });
  it("never allows more than the hard cap even when the setting is higher", () => expect(lengthRangeProblem(3, 31, 240)).not.toBeNull());
});

describe("validateOutline", () => {
  it("accepts 3 to 6 chapters that fit the range and stamps the video's range", () => {
    const r = validateOutline(good, { min: 3, max: 8 });
    expect(r.ok && r.outline.length).toEqual({ min_minutes: 3, max_minutes: 8 });
  });
  it("refuses fewer than 3 and more than 6 chapters", () => {
    expect(validateOutline({ chapters: good.chapters.slice(0, 2) }, { min: 1, max: 8 }).ok).toBe(false);
    expect(validateOutline({ chapters: Array.from({ length: 7 }, (_, i) => ch(`c${i}`, 60)) }, { min: 3, max: 8 }).ok).toBe(false);
  });
  it("refuses a total outside the minutes range", () => {
    expect(validateOutline({ chapters: [ch("a", 30), ch("b", 30), ch("c", 30)] }, { min: 3, max: 8 }).ok).toBe(false); // 90 s is under 3 min
    expect(validateOutline({ chapters: [ch("a", 200), ch("b", 200), ch("c", 200)] }, { min: 3, max: 8 }).ok).toBe(false); // 10 min is over 8
    expect(validateOutline({ chapters: [ch("a", 100), ch("b", 100), ch("c", 100)] }, { min: 3, max: 8 }).ok).toBe(true);
    expect(validateOutline({ chapters: [ch("a", 100), ch("b", 100), ch("c", 100)] }, { min: 6, max: 8 }).ok).toBe(false);
  });
  it("refuses control characters, empty titles, unknown keys and non-integer seconds", () => {
    expect(validateOutline({ chapters: [ch("bad\u0000", 100), ch("b", 100), ch("c", 100)] }, { min: 5, max: 8 }).ok).toBe(false);
    expect(validateOutline({ chapters: [ch("  ", 100), ch("b", 100), ch("c", 100)] }, { min: 5, max: 8 }).ok).toBe(false);
    expect(validateOutline({ chapters: [{ ...ch("a", 100), extra: 1 }, ch("b", 100), ch("c", 100)] }, { min: 5, max: 8 }).ok).toBe(false);
    expect(validateOutline({ chapters: [ch("a", 100.5), ch("b", 100), ch("c", 100)] }, { min: 5, max: 8 }).ok).toBe(false);
    expect(validateOutline("nope", { min: 3, max: 8 }).ok).toBe(false);
  });
});

describe("estimates", () => {
  it("counts seconds and words per chapter at the language pace", () => {
    const o = validateOutline(good, { min: 3, max: 8 });
    if (!o.ok) throw new Error("outline");
    const e = outlineEstimate(o.outline, "en");
    expect(e.totalS).toBe(360);
    expect(e.chapters.map((c) => c.words)).toEqual([243, 405, 324]);
    expect(e.words).toBe(972);
    expect(outlineEstimate(o.outline, "ml").words).toBeLessThan(e.words); // Malayalam is slower
  });
  it("derives the script word range from the chosen minutes", () => {
    expect(longWordRange("en", { min: 3, max: 8 })).toEqual({ min: 437, max: 1426 });
  });
  it("formats clock times", () => {
    expect(clock(65)).toBe("1:05");
    expect(clock(600)).toBe("10:00");
  });
});

describe("chapterMarks", () => {
  it("keeps each chapter's share on the real timeline and starts at 0", () => {
    const m = chapterMarks(good, 720_000);
    expect(m.map((x) => x.startMs)).toEqual([0, 180_000, 480_000]);
    expect(m[0]!.title).toBe("Hook");
  });
});

describe("lengthVsQaProblem", () => {
  const qa = { minS: 180, maxS: 900 }; // the defaults of qa.long_min_s and qa.long_max_s
  it("accepts the default 3 to 8 and the 15 minute edge", () => {
    expect(lengthVsQaProblem({ min: 3, max: 8 }, qa)).toBeNull();
    expect(lengthVsQaProblem({ min: 3, max: 15 }, qa)).toBeNull();
  });
  it("refuses a range the QA check would block after the money is spent", () => {
    expect(lengthVsQaProblem({ min: 3, max: 16 }, qa)).toMatch(/QA long: longest/);
    expect(lengthVsQaProblem({ min: 3, max: 8 }, { minS: 240, maxS: 900 })).toMatch(/QA long: shortest/);
  });
});

describe("chapterMarksFromScenes", () => {
  const scenes = [
    { beat: "c1_b1", startMs: 0 },
    { beat: "c1_b2", startMs: 40_000 },
    { beat: "c2_b1", startMs: 100_000 },
    { beat: "c3_b1", startMs: 250_000 },
  ];
  it("starts each chapter where its first scene starts", () => {
    const r = chapterMarksFromScenes(good, scenes, 360_000);
    expect(r.from).toBe("scenes");
    expect(r.marks.map((m) => m.startMs)).toEqual([0, 100_000, 250_000]);
  });
  it("starts the first chapter at 0 even if its first scene does not", () => {
    expect(chapterMarksFromScenes(good, scenes.map((s) => ({ ...s, startMs: s.startMs + 500 })), 360_000).marks[0]!.startMs).toBe(0);
  });
  it("falls back to the outline's shares when a chapter has no scene or the order is wrong", () => {
    const missing = chapterMarksFromScenes(good, scenes.filter((s) => !s.beat.startsWith("c2_")), 720_000);
    expect(missing.from).toBe("estimate");
    expect(missing.marks.map((m) => m.startMs)).toEqual([0, 180_000, 480_000]);
    expect(chapterMarksFromScenes(good, [{ beat: "c1_b1", startMs: 0 }, { beat: "c2_b1", startMs: 200_000 }, { beat: "c3_b1", startMs: 100_000 }], 360_000).from).toBe("estimate");
  });
  it("does not mistake c10 or a loose id for chapter 1", () => {
    expect(chapterMarksFromScenes(good, [{ beat: "hook", startMs: 0 }, { beat: "c10_b1", startMs: 5 }], 360_000).from).toBe("estimate");
  });
});

describe("chapterTimestampLines", () => {
  const marks = [{ title: "Hook", startMs: 0 }, { title: "How it works", startMs: 100_000 }, { title: "Why", startMs: 250_000 }];
  it("writes m:ss lines", () => expect(chapterTimestampLines(marks, 360_000)).toBe("0:00 Hook\n1:40 How it works\n4:10 Why"));
  it("uses h:mm:ss for a video of an hour or more", () => expect(chapterTimestampLines(marks, 3_700_000)?.split("\n")[0]).toBe("0:00:00 Hook"));
  it("returns null when YouTube would ignore the chapters", () => {
    expect(chapterTimestampLines(marks.slice(0, 2), 360_000)).toBeNull(); // fewer than 3
    expect(chapterTimestampLines([{ title: "a", startMs: 0 }, { title: "b", startMs: 5_000 }, { title: "c", startMs: 60_000 }], 120_000)).toBeNull(); // 5 s chapter
    expect(chapterTimestampLines([{ title: "a", startMs: 1000 }, { title: "b", startMs: 60_000 }, { title: "c", startMs: 120_000 }], 200_000)).toBeNull(); // not 0:00
  });
});

describe("chapterFrameChunks", () => {
  const at = (...ms: number[]) => ms.map((startMs) => ({ startMs }));
  it("cuts at the chapter starts and covers every frame once", () => {
    expect(chapterFrameChunks(at(0, 100_000, 250_000), 30)).toEqual([{ from: 0, to: 2999 }, { from: 3000, to: 7499 }, { from: 7500, to: "end" }]);
  });
  it("one chapter is one chunk to the end", () => expect(chapterFrameChunks(at(0), 30)).toEqual([{ from: 0, to: "end" }]));
  it("merges chapters that start on the same frame, and the first always starts at frame 0", () => {
    expect(chapterFrameChunks(at(0, 10_000, 10_010, 20_000), 30)).toEqual([{ from: 0, to: 299 }, { from: 300, to: 599 }, { from: 600, to: "end" }]);
    expect(chapterFrameChunks(at(500, 10_000), 30)).toEqual([{ from: 0, to: 299 }, { from: 300, to: "end" }]);
  });
});
