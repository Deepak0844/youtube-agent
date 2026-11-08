import { describe, expect, it } from "vitest";
import { chapterMarks, clock, lengthRangeProblem, longWordRange, outlineEstimate, validateOutline } from "@/server/core/long-form";

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
