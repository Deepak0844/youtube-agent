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

export interface ChapterMark {
  title: string;
  startMs: number;
}

/**
 * Chapter starts on the real timeline, taken from the scenes: the script's beat ids start with the chapter number (c1_b1, c2_b1 ...),
 * so a chapter begins where its first scene begins. If any chapter has no scene, or the order is not strictly rising, the chapters fall
 * back to their share of the outline's target seconds (chapterMarks). The first chapter always starts at 0.
 */
export function chapterMarksFromScenes(outline: Pick<Outline, "chapters">, scenes: ReadonlyArray<{ beat: string; startMs: number }>, totalMs: number): { marks: ChapterMark[]; from: "scenes" | "estimate" } {
  const starts = outline.chapters.map((_, i) => scenes.find((s) => s.beat.startsWith(`c${i + 1}_`))?.startMs);
  const ok = starts.every((s, i) => s !== undefined && Number.isFinite(s) && (i === 0 || s > starts[i - 1]!));
  if (!ok) return { marks: chapterMarks(outline, totalMs), from: "estimate" };
  return { marks: outline.chapters.map((c, i) => ({ title: c.title, startMs: i === 0 ? 0 : starts[i]! })), from: "scenes" };
}

/** YouTube shows chapters only when the first starts at 0:00, there are at least 3, and each lasts at least 10 seconds. */
export const MIN_YT_CHAPTER_S = 10;

const stamp = (ms: number, hours: boolean): string => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return hours ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};

/** The description lines "0:00 Title" for YouTube chapters, or null when YouTube would not show them (see MIN_YT_CHAPTER_S). */
export function chapterTimestampLines(marks: readonly ChapterMark[], totalMs: number): string | null {
  if (marks.length < 3 || marks[0]!.startMs !== 0) return null;
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1]!.startMs : totalMs;
    if (end - marks[i]!.startMs < MIN_YT_CHAPTER_S * 1000) return null;
  }
  const hours = totalMs >= 3_600_000;
  return marks.map((m) => `${stamp(m.startMs, hours)} ${m.title.replace(/[<>]/g, "")}`).join("\n");
}

/** One chunk of a long render: frames `from` to `to` (inclusive) of the whole composition; "end" = through its last frame. */
export interface FrameChunk {
  from: number;
  to: number | "end";
}

/**
 * Splits the video into one chunk per chapter, on the same timeline as the whole video (so chapter cards, the progress bar and the
 * captions stay right). A chapter starts at the frame of its first scene; chapters that land on the same frame are merged. The chunks
 * cover every frame once, from 0 to the end.
 */
export function chapterFrameChunks(marks: readonly Pick<ChapterMark, "startMs">[], fps: number): FrameChunk[] {
  const froms: number[] = [];
  for (const [i, m] of marks.entries()) {
    const f = i === 0 ? 0 : Math.round((m.startMs * fps) / 1000);
    if (froms.length === 0 || f > froms[froms.length - 1]!) froms.push(f);
  }
  if (froms.length === 0) froms.push(0);
  return froms.map((from, i) => ({ from, to: i + 1 < froms.length ? froms[i + 1]! - 1 : ("end" as const) }));
}
