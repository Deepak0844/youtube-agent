import { describe, expect, it } from "vitest";
import { captionsCheck, checkClip, hookCheck, loudnessCheck, type ClipWord } from "@/server/core/clip-checks";

/** Words spoken at 3 a second from `at`; `n` words. */
const speak = (n: number, at = 0.2, prefix = "Why"): ClipWord[] => Array.from({ length: n }, (_, i) => ({ word: i === 0 ? prefix : i === n - 1 ? "end." : `w${i}`, startS: at + i / 3, endS: at + i / 3 + 0.25 }));
const clip30 = speak(85, 0.2).map((w, i) => (i === 9 ? { ...w, word: "stop." } : w)); // about 28.5 s of speech, the opener ends after 10 words

describe("hookCheck", () => {
  it("passes a short opener spoken at the start", () => {
    expect(hookCheck(speak(10))).toEqual({ id: "hook", ok: true, warning: null });
  });
  it("warns when the first word comes after 3 s, with the time in the sentence", () => {
    const r = hookCheck(speak(10, 3.5));
    expect(r.ok).toBe(false);
    expect(r.warning).toMatch(/3\.5 s in/);
    expect(hookCheck(speak(10, 3)).ok).toBe(true); // exactly 3 s is allowed
  });
  it("warns when the clip opens with a joining word", () => {
    expect(hookCheck(speak(10, 0.2, "And")).warning).toMatch(/mid-thought/);
    expect(hookCheck(speak(10, 0.2, "This")).ok).toBe(true); // "This is..." is a normal opener
  });
  it("warns on a long preamble sentence", () => {
    const long = speak(40).map((w) => ({ ...w, word: w.word === "end." ? "x" : w.word }));
    expect(hookCheck(long).warning).toMatch(/25 words/);
  });
  it("warns when the first word's time is not a number (NaN > 3 is false, it must not pass)", () => {
    expect(hookCheck([{ word: "Why", startS: Number.NaN, endS: 1 }]).ok).toBe(false);
  });
  it("warns on a clip with no words", () => {
    expect(hookCheck([]).warning).toMatch(/no spoken words/);
  });
});

describe("loudnessCheck", () => {
  it("passes inside the app's range", () => {
    expect(loudnessCheck(-16, -3).ok).toBe(true);
    expect(loudnessCheck(-20, null).ok).toBe(true); // edges are inside
    expect(loudnessCheck(-12, -1).ok).toBe(true);
  });
  it("warns too quiet, too loud, clipping and unmeasured", () => {
    expect(loudnessCheck(-24, -3).warning).toMatch(/-24\.0 LUFS/);
    expect(loudnessCheck(-9, -3).ok).toBe(false);
    expect(loudnessCheck(-16, 0.5).warning).toMatch(/clip/);
    expect(loudnessCheck(null, null).warning).toMatch(/could not be measured/);
    expect(loudnessCheck(Number.NaN, null).ok).toBe(false);
  });
});

describe("captionsCheck", () => {
  it("passes words that cover the clip and sit inside it", () => {
    expect(captionsCheck(clip30, 30).ok).toBe(true);
  });
  it("warns on no words, no length, bad or unordered times", () => {
    expect(captionsCheck([], 30).warning).toMatch(/no caption words/);
    expect(captionsCheck(clip30, 0).warning).toMatch(/no length/);
    expect(captionsCheck([{ word: "a", startS: 5, endS: 4 }], 30).warning).toMatch(/not valid/);
    expect(captionsCheck([{ word: "a", startS: 5, endS: 6 }, { word: "b", startS: 1, endS: 2 }], 30).warning).toMatch(/not valid or not in order/);
    expect(captionsCheck([{ word: "a", startS: Number.NaN, endS: 2 }], 30).ok).toBe(false);
  });
  it("warns when a word is cut off at either end", () => {
    expect(captionsCheck(speak(85, 0.2), 20).warning).toMatch(/outside the clip/);
    expect(captionsCheck([{ word: "a", startS: -0.5, endS: 1 }, ...speak(80, 1)], 30).warning).toMatch(/outside the clip/);
  });
  it("warns when the captions cover too little of the clip", () => {
    expect(captionsCheck(speak(20, 0.2), 30).warning).toMatch(/cover only \d+%/);
  });
});

describe("checkClip", () => {
  const good = { words: clip30, durationS: 30, lufs: -16, truePeakDb: -3 };
  it("a clip that passes everything is ok with no warnings", () => {
    expect(checkClip(good)).toMatchObject({ ok: true, warnings: [] });
  });
  it("collects every failed check as a plain warning and keeps the clip (never drops it)", () => {
    const r = checkClip({ words: speak(20, 4), durationS: 30, lufs: -30, truePeakDb: null });
    expect(r.ok).toBe(false);
    expect(r.checks.map((c) => c.id)).toEqual(["hook", "loudness", "captions"]);
    expect(r.checks.every((c) => !c.ok)).toBe(true);
    expect(r.warnings).toHaveLength(3);
  });
});
