import { z } from "zod";
import { speakingRate, type Lang } from "@/server/core/lang";

// Long videos (Phase 6b): the length range, the outline (3 to 6 chapters), and the pure numbers derived from them. No IO.
// A long video stays ONE video: the outline is a content version, the owner approves it at the outline gate, and the script
// (Draft) is then written against exactly that outline.

export const LONG_MIN_MINUTES = 3;
export const LONG_DEFAULT_RANGE = { min: 3, max: 8 } as const;
/** Whatever video.max_long_minutes says, one render pass and one scenes file hold at most this many minutes (the checkpointed render is the next piece). */
export const LONG_HARD_MAX_MINUTES = 30;
export const OUTLINE_CHAPTERS = { min: 3, max: 6 } as const;
export const MIN_CHAPTER_S = 20;

export interface LengthRange {
  min: number;
  max: number;
}

/** Why a minutes range is not allowed, or null. `settingMax` is the video.max_long_minutes setting. */
export function lengthRangeProblem(min: unknown, max: unknown, settingMax: number): string | null {
  if (!Number.isInteger(min) || !Number.isInteger(max)) return "Enter the length in whole minutes.";
  const lo = min as number;
  const hi = max as number;
  const cap = Math.min(settingMax, LONG_HARD_MAX_MINUTES);
  if (lo < LONG_MIN_MINUTES) return `A long video is at least ${LONG_MIN_MINUTES} minutes.`;
  if (lo > hi) return "The shortest length cannot be more than the longest.";
  if (hi > cap) return `The longest length is ${cap} minutes (Settings > System, "Longest long video"${settingMax > LONG_HARD_MAX_MINUTES ? `; one render holds at most ${LONG_HARD_MAX_MINUTES}` : ""}).`;
  return null;
}

/** Why the QA length limits (settings qa.long_min_s / qa.long_max_s) would fail a video of this range after the money is spent, or null. */
export function lengthVsQaProblem(range: LengthRange, qa: { minS: number; maxS: number }): string | null {
  if (range.min * 60 < qa.minS) return `The QA check fails long videos under ${qa.minS} seconds ("QA long: shortest"). Pick at least ${Math.ceil(qa.minS / 60)} minutes or lower that setting first.`;
  if (range.max * 60 > qa.maxS) return `The QA check fails long videos over ${qa.maxS} seconds ("QA long: longest"). Pick at most ${Math.floor(qa.maxS / 60)} minutes or raise that setting first.`;
  return null;
}

const text = (max: number) => z.string().trim().min(1).max(max).refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s) && s.isWellFormed(), "contains a control character");

export const outlineChapterSchema = z.strictObject({
  title: text(80),
  line: text(200),
  target_s: z.number().int().min(MIN_CHAPTER_S).max(LONG_HARD_MAX_MINUTES * 60),
});
export const outlineSchema = z.strictObject({
  chapters: z.array(outlineChapterSchema).min(OUTLINE_CHAPTERS.min).max(OUTLINE_CHAPTERS.max),
  length: z.strictObject({ min_minutes: z.number().int(), max_minutes: z.number().int() }),
});
export type Outline = z.infer<typeof outlineSchema>;
export type OutlineChapter = z.infer<typeof outlineChapterSchema>;

export const outlineTotalS = (chapters: readonly Pick<OutlineChapter, "target_s">[]): number => chapters.reduce((a, c) => a + c.target_s, 0);

/** The chapters the model or the owner wrote, checked against the video's own length range. The range in the body is overwritten with the video's. */
export function validateOutline(raw: unknown, range: LengthRange): { ok: true; outline: Outline } | { ok: false; problems: string[] } {
  const body = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? { chapters: (raw as { chapters?: unknown }).chapters, length: { min_minutes: range.min, max_minutes: range.max } } : raw;
  const p = outlineSchema.safeParse(body);
  if (!p.success) return { ok: false, problems: p.error.issues.map((i) => `${i.path.join(".") || "outline"}: ${i.message}`) };
  const total = outlineTotalS(p.data.chapters);
  if (total < range.min * 60 || total > range.max * 60) return { ok: false, problems: [`the chapters add up to ${total} seconds; they must add up to between ${range.min * 60} and ${range.max * 60} seconds (${range.min} to ${range.max} minutes)`] };
  return { ok: true, outline: p.data };
}

/** Narration words the whole script should have: the chosen minutes at this language's speaking pace, with a little room either side. */
export function longWordRange(lang: Lang, range: LengthRange): { min: number; max: number } {
  const wps = speakingRate(lang);
  return { min: Math.round(range.min * 60 * wps * 0.9), max: Math.round(range.max * 60 * wps * 1.1) };
}

export interface OutlineEstimate {
  totalS: number;
  words: number;
  chapters: Array<{ title: string; line: string; targetS: number; words: number }>;
}

/** What the outline gate shows: seconds and narration words per chapter. The voice price is shown at the cost step (no per-character price is known here). */
export function outlineEstimate(outline: Outline, lang: Lang): OutlineEstimate {
  const wps = speakingRate(lang);
  const chapters = outline.chapters.map((c) => ({ title: c.title, line: c.line, targetS: c.target_s, words: Math.round(c.target_s * wps) }));
  return { totalS: outlineTotalS(outline.chapters), words: chapters.reduce((a, c) => a + c.words, 0), chapters };
}

/** "3:05" style. */
export const clock = (s: number): string => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

/**
 * Chapter start times on the real timeline: the outline's target seconds say how the video is split, the real length (after the
 * narration is timed) says how long it is, so each chapter keeps its share. The first chapter starts at 0.
 */
export function chapterMarks(outline: Pick<Outline, "chapters">, totalMs: number): Array<{ title: string; startMs: number }> {
  const total = outlineTotalS(outline.chapters);
  let acc = 0;
  return outline.chapters.map((c) => {
    const startMs = Math.round((acc / total) * totalMs);
    acc += c.target_s;
    return { title: c.title, startMs };
  });
}
