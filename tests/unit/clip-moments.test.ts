import { describe, expect, it } from "vitest";
import { findMoments, validateWords, type MomentWord } from "@/server/core/clip-moments";

/** Builds words at 3 per second from sentences; each sentence ends with a full stop; `gap` seconds of silence between sentences. */
function talk(sentences: string[], gap = 0.4): MomentWord[] {
  const out: MomentWord[] = [];
  let t = 0;
  for (const s of sentences) {
    for (const w of s.split(" ")) { out.push({ word: w, startS: t, endS: t + 0.3 }); t += 1 / 3; }
    t += gap;
  }
  return out;
}
const sentence = (i: number, n = 12) => `Point ${i} ` + Array.from({ length: n - 2 }, (_, k) => `word${k}`).join(" ") + ".";
// 12 words at 3 per second = 4 s a sentence plus 0.4 s gap
const long = talk(Array.from({ length: 60 }, (_, i) => sentence(i)));

describe("findMoments", () => {
  it("returns clips inside the length limits, sorted by time, that never overlap", () => {
    const r = findMoments(long);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.moments.length).toBeGreaterThanOrEqual(3);
    expect(r.moments.length).toBeLessThanOrEqual(10);
    for (const [i, m] of r.moments.entries()) {
      expect(m.endS - m.startS).toBeGreaterThanOrEqual(15);
      expect(m.endS - m.startS).toBeLessThanOrEqual(90);
      if (i > 0) expect(m.startS).toBeGreaterThanOrEqual(r.moments[i - 1]!.endS);
    }
  });

  it("starts on the first word of a sentence and ends on a full stop, never mid-sentence", () => {
    const r = findMoments(long);
    if (!r.ok) throw new Error(r.reason);
    for (const m of r.moments) {
      const inside = long.filter((w) => w.startS >= m.startS && w.endS <= m.endS);
      expect(inside[0]!.word).toBe("Point");
      expect(inside.at(-1)!.word).toMatch(/\.$/);
      expect(m.hook.startsWith("Point")).toBe(true);
    }
  });

  it("honours the count and length options", () => {
    const r = findMoments(long, { max: 2, minS: 20, maxS: 30 });
    if (!r.ok) throw new Error(r.reason);
    expect(r.moments).toHaveLength(2);
    for (const m of r.moments) expect(m.endS - m.startS).toBeLessThanOrEqual(30);
  });

  it("prefers a clip that opens with a question over one that opens mid-thought", () => {
    const strong = ["Why is the sky blue?", ...Array.from({ length: 6 }, (_, i) => sentence(i))];
    const weak = ["And so it goes on and on here.", ...Array.from({ length: 6 }, (_, i) => sentence(i + 10))];
    const words = talk([...weak, ...strong], 1.5);
    const r = findMoments(words, { max: 1, minS: 20, maxS: 30 });
    if (!r.ok) throw new Error(r.reason);
    expect(r.moments[0]!.hook).toMatch(/^Why is the sky blue\?/);
  });

  it("splits sentences at a long silence even without punctuation", () => {
    const w: MomentWord[] = [];
    let t = 0;
    for (let s = 0; s < 8; s++) {
      for (let k = 0; k < 20; k++) { w.push({ word: `x${k}`, startS: t, endS: t + 0.3 }); t += 0.34; }
      t += 2; // silence
    }
    const r = findMoments(w, { minS: 10, maxS: 20 });
    if (!r.ok) throw new Error(r.reason);
    // every clip starts at the first word of a burst (x0) and ends at the last (x19): it was split at the silence, not mid-burst
    for (const m of r.moments) {
      const inside = w.filter((x) => x.startS >= m.startS && x.endS <= m.endS);
      expect(inside[0]!.word).toBe("x0");
      expect(inside.at(-1)!.word).toBe("x19");
    }
  });

  it("does not end a sentence at an abbreviation", () => {
    // one long sentence with "Dr." inside; its tail is a strong question that would win as a clip start if "Dr." ended the sentence
    const first = [...Array.from({ length: 14 }, (_, i) => `w${i}`), "Dr.", "Why", "is", "the", "sky", "blue?"];
    const words = talk([first.join(" "), sentence(2), sentence(3), sentence(4)]);
    const r = findMoments(words, { minS: 10, maxS: 200, max: 10 });
    if (!r.ok) throw new Error(r.reason);
    for (const m of r.moments) expect(m.hook).not.toMatch(/^Why is the sky blue/);
  });

  it("never cuts into its own first or last word when word times overlap", () => {
    const w: MomentWord[] = long.map((x, i) => (i % 12 === 0 && i > 0 ? { ...x, startS: x.startS - 0.4 } : x)); // each sentence's first word starts early, overlapping the one before
    const r = findMoments(w, { minS: 15, maxS: 40 });
    if (!r.ok) throw new Error(r.reason);
    for (const m of r.moments) {
      const first = w.find((x) => x.word === "Point" && x.startS >= m.startS - 0.5)!;
      expect(m.startS).toBeLessThanOrEqual(first.startS);
    }
  });

  it("says plainly when nothing fits", () => {
    const short = talk([sentence(1), sentence(2)]);
    expect(findMoments(short)).toMatchObject({ ok: false, reason: expect.stringMatching(/No run of whole sentences/) });
    const one = talk(["a ".repeat(400).trim() + "."]); // one 130 s sentence
    expect(findMoments(one)).toMatchObject({ ok: false });
  });

  it("refuses bad input: no words, unordered, negative, NaN, bad options", () => {
    expect(findMoments([])).toMatchObject({ ok: false, reason: expect.stringMatching(/no words/i) });
    expect(findMoments([{ word: "a", startS: 5, endS: 6 }, { word: "b", startS: 1, endS: 2 }])).toMatchObject({ ok: false, reason: expect.stringMatching(/in order/) });
    expect(validateWords([{ word: "a", startS: -1, endS: 1 }])).toMatch(/not valid/);
    expect(validateWords([{ word: "a", startS: 3, endS: 2 }])).toMatch(/not valid/);
    expect(validateWords([{ word: "a", startS: Number.NaN, endS: 2 }])).toMatch(/not valid/);
    expect(findMoments(long, { max: 0 })).toMatchObject({ ok: false });
    expect(findMoments(long, { minS: 50, maxS: 10 })).toMatchObject({ ok: false });
  });

  it("is deterministic", () => {
    expect(findMoments(long)).toEqual(findMoments(long));
  });
});
