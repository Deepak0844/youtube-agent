import { describe, expect, it } from "vitest";
import { chapterFingerprint, chapterWindows } from "@/server/core/chapter-windows";
import { validateOutline, TSX_CHAPTER_MAX_S, TSX_LONG_MAX_MINUTES } from "@/server/core/long-form";
import { outlineMessages } from "@/server/authoring/outline";
import { TAIL_S, type PromptBeat, type PromptWord } from "@/server/core/tsx-prompt";

const ch = (title: string, target_s: number) => ({ title, line: `${title} line`, target_s });
const outline = { chapters: [ch("Hook", 30), ch("Phonebook", 40), ch("Journey", 45), ch("Answer", 40), ch("Cache", 35)] };

/** Beats of 10 words (3 a second); `per` beats in each chapter. Word times follow the text exactly, so the beats and the narration match. */
function script(per: number[]): { beats: PromptBeat[]; words: PromptWord[]; narrationS: number } {
  const beats: PromptBeat[] = [];
  const words: PromptWord[] = [];
  let t = 0;
  per.forEach((count, c) => {
    for (let b = 0; b < count; b++) {
      const text = Array.from({ length: 10 }, (_, k) => `w${c + 1}x${b + 1}x${k}`).join(" ");
      beats.push({ id: `c${c + 1}_b${b + 1}`, text, visual: `picture ${c + 1}.${b + 1}` });
      for (const w of text.split(" ")) { words.push({ word: w, startS: Math.round(t * 1000) / 1000, endS: Math.round((t + 0.3) * 1000) / 1000 }); t += 1 / 3; }
    }
  });
  return { beats, words, narrationS: t };
}

describe("chapterWindows", () => {
  it("tiles the whole video: chapter frames add up to the narration's frames, in order, with the words shifted to each chapter", () => {
    const s = script([3, 4, 4, 4, 3]); // 18 beats of 10 words: 60 s of speech
    const r = chapterWindows({ outline, ...s });
    if (!r.ok) throw new Error(r.reason);
    expect(r.chapters.map((c) => c.index)).toEqual([1, 2, 3, 4, 5]);
    expect(r.chapters.map((c) => c.beats.length)).toEqual([3, 4, 4, 4, 3]);
    expect(r.totalFrames).toBe(Math.ceil((s.narrationS + TAIL_S) * 30 - 1e-9));
    expect(r.chapters.reduce((a, c) => a + c.frames, 0)).toBe(r.totalFrames); // no gap, no overlap, no drift
    expect(r.chapters[0]!.startFrame).toBe(0);
    for (let i = 1; i < 5; i++) expect(r.chapters[i]!.startFrame).toBe(r.chapters[i - 1]!.startFrame + r.chapters[i - 1]!.frames);
    for (const c of r.chapters) {
      expect(c.words.length).toBeGreaterThan(20);
      expect(c.words[0]!.startS).toBeLessThan(0.4); // shifted to the chapter's own start
      expect(c.words.at(-1)!.endS).toBeLessThanOrEqual(c.frames / 30 + 0.001);
      expect(c.title).toBe(outline.chapters[c.index - 1]!.title);
    }
    expect(r.chapters.reduce((a, c) => a + c.words.length, 0)).toBe(s.words.length); // every word lands in exactly one chapter
  });

  it("refuses beats that do not follow the chapters, with a plain sentence", () => {
    const s = script([3, 3, 3, 3, 3]);
    const rename = (f: (b: PromptBeat, i: number) => string) => ({ ...s, beats: s.beats.map((b, i) => ({ ...b, id: f(b, i) })) });
    expect(chapterWindows({ outline, ...rename((_, i) => `beat${i}`) })).toMatchObject({ ok: false, reason: expect.stringMatching(/does not belong to one of the 5 chapters/) });
    expect(chapterWindows({ outline, ...rename((b) => b.id.replace(/^c5_/, "c6_")) })).toMatchObject({ ok: false, reason: expect.stringMatching(/c6_b1/) });
    expect(chapterWindows({ outline, ...rename((b) => b.id.replace(/^c3_/, "c4_")) })).toMatchObject({ ok: false, reason: expect.stringMatching(/Chapter 3 has no beats/) });
    expect(chapterWindows({ outline, ...s, beats: s.beats.slice(0, 12) })).toMatchObject({ ok: false, reason: expect.stringMatching(/Chapter 5 has no beats/) });
    const back = [...s.beats]; [back[2], back[3]] = [back[3]!, back[2]!];
    expect(chapterWindows({ outline, ...s, beats: back })).toMatchObject({ ok: false, reason: expect.stringMatching(/in order/) });
    expect(chapterWindows({ outline: { chapters: [] }, ...s })).toMatchObject({ ok: false, reason: expect.stringMatching(/no chapters/) });
    expect(chapterWindows({ outline, ...s, narrationS: 0 })).toMatchObject({ ok: false });
  });

  it("a video longer than 90 s in total is fine (the total is not clamped to one code scene), only a chapter over 90 s is refused", () => {
    const s = script([8, 8, 8, 8, 8]); // 40 beats = 133 s in five chapters of about 27 s
    const r = chapterWindows({ outline, ...s });
    if (!r.ok) throw new Error(r.reason);
    expect(r.totalFrames).toBeGreaterThan(2700);
    expect(r.chapters.reduce((a, c) => a + c.frames, 0)).toBe(r.totalFrames);
    expect(r.chapters.every((c) => c.frames <= 2700)).toBe(true);
  });

  it("refuses a chapter longer than one code scene may run (90 s) and names it", () => {
    const s = script([3, 3, 3, 3, 30]); // chapter 5 is 30 beats = 100 s
    expect(chapterWindows({ outline, ...s })).toMatchObject({ ok: false, reason: expect.stringMatching(/Chapter 5 is 10\d(\.\d+)? seconds long; one code scene may run at most 90 seconds/) });
    const ok = script([3, 3, 3, 3, 26]); // 86.7 s is fine
    expect(chapterWindows({ outline, ...ok }).ok).toBe(true);
  });
});

describe("chapterFingerprint", () => {
  const s = script([2, 2, 2, 2, 2]);
  const base = chapterWindows({ outline, ...s });
  if (!base.ok) throw new Error(base.reason);
  const c = base.chapters[1]!;
  const fp = (x = c, e: { style: string | null; orientation: "portrait" | "landscape" } = { style: "flat_motion", orientation: "landscape" }) => chapterFingerprint(x, e);
  it("is stable, and changes with the words, the picture asked for, the timing, the look and the size", () => {
    expect(fp()).toBe(fp());
    expect(fp()).toMatch(/^[0-9a-f]{64}$/);
    expect(fp({ ...c, beats: c.beats.map((b, i) => (i === 0 ? { ...b, text: b.text + " more" } : b)) })).not.toBe(fp());
    expect(fp({ ...c, beats: c.beats.map((b, i) => (i === 0 ? { ...b, visual: "other" } : b)) })).not.toBe(fp());
    expect(fp({ ...c, frames: c.frames + 1 })).not.toBe(fp());
    expect(fp({ ...c, startFrame: c.startFrame + 30 })).not.toBe(fp());
    expect(fp(c, { style: "ai_studio", orientation: "landscape" })).not.toBe(fp());
    expect(fp(c, { style: "flat_motion", orientation: "portrait" })).not.toBe(fp());
  });
  it("is the same for the same chapter of another run, so a finished chapter is not drawn again", () => {
    const again = chapterWindows({ outline, ...script([2, 2, 2, 2, 2]) });
    if (!again.ok) throw new Error(again.reason);
    expect(fp(again.chapters[1]!)).toBe(fp());
  });
});

describe("the 90-second chapter rule in the outline", () => {
  const range = { min: 3, max: 4 };
  const ok = { chapters: [ch("A", 60), ch("B", 60), ch("C", 60), ch("D", 40)] };
  it("accepts chapters up to 90 s and refuses longer ones for a code-scene video only", () => {
    expect(validateOutline(ok, range, { maxChapterS: TSX_CHAPTER_MAX_S }).ok).toBe(true);
    const long = { chapters: [ch("A", 100), ch("B", 60), ch("C", 60)] };
    expect(validateOutline(long, range, { maxChapterS: TSX_CHAPTER_MAX_S })).toMatchObject({ ok: false, problems: [expect.stringMatching(/chapter 1 is 100 seconds; no chapter may be over 90 seconds \(split it into two chapters\)/)] });
    expect(validateOutline(long, range).ok).toBe(true); // other kinds keep the old rule
  });
  it("six chapters of 90 s are the most a code-scene video can have: 9 minutes, and the outline prompt says the limit", () => {
    expect(TSX_LONG_MAX_MINUTES).toBe(9);
    const sys = String(outlineMessages({ topic: "t", lang: "en", range, maxChapterS: 90 })[0]!.content);
    expect(sys).toMatch(/no chapter is over 90 seconds/);
    expect(String(outlineMessages({ topic: "t", lang: "en", range })[0]!.content)).toMatch(/no chapter is over 1800 seconds/);
  });
});

describe("chapterSeamCues", () => {
  it("one soft whoosh just before every chapter after the first, optional", async () => {
    const { chapterSeamCues } = await import("@/server/core/chapter-windows");
    const r = chapterSeamCues([{ index: 1, startS: 0 }, { index: 2, startS: 40 }, { index: 3, startS: 81.5 }]);
    expect(r.cues.map((c) => [c.id, c.sound, c.atS, c.optional])).toEqual([["seam-2", "whoosh-soft", 39.85, true], ["seam-3", "whoosh-soft", 81.35, true]]);
    expect(chapterSeamCues([{ index: 1, startS: 0 }]).cues).toEqual([]);
  });
});
