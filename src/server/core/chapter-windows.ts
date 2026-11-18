// Long videos, L3a: where each chapter of a long code-scene video sits on the narration, in seconds and in frames. Pure: no IO.
// The script's beats are named c1_b1, c1_b2, c2_b1, ... (the chapter number is the prefix), the narration gives every word its seconds, and the
// frames of the chapters add up to exactly the whole video's frames, so joined chapters never drift from the voice. Each chapter is one code-scene
// file, so it may run at most TSX_MAX_FRAMES (90 s).
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import type { Outline } from "@/server/core/long-form";
import { beatTimings, TAIL_S, type PromptBeat, type PromptWord } from "@/server/core/tsx-prompt";
import { TSX_MAX_FRAMES } from "@/server/core/tsx-check";

const FPS = 30;
/** how far before the seam the whoosh starts */
const SEAM_LEAD_S = 0.15;
const CHAPTER_OF = /^c(\d{1,2})_/;

export interface ChapterWindow {
  /** 1 to N */
  index: number;
  title: string;
  line: string;
  beats: PromptBeat[];
  /** frame-aligned seconds on the whole narration */
  startS: number;
  endS: number;
  startFrame: number;
  /** this chapter's file must have exactly this many frames */
  frames: number;
  /** the words spoken inside the chapter, shifted to start at 0 */
  words: PromptWord[];
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** The chapters with their windows, or one plain sentence saying why the script and the outline do not fit together. */
export function chapterWindows(a: {
  outline: Pick<Outline, "chapters">;
  beats: readonly PromptBeat[];
  words: readonly PromptWord[];
  narrationS: number;
}): { ok: true; chapters: ChapterWindow[]; totalFrames: number } | { ok: false; reason: string } {
  const n = a.outline.chapters.length;
  if (n < 1) return { ok: false, reason: "The outline has no chapters." };
  if (!(a.narrationS > 0)) return { ok: false, reason: "The narration has no length." };
  // Beats grouped by the chapter number in their id, in order: 1, 1, 2, 2, 2, 3 ... never back, never a gap.
  const groups: PromptBeat[][] = Array.from({ length: n }, () => []);
  let last = 0;
  for (const b of a.beats) {
    const m = CHAPTER_OF.exec(b.id);
    const k = m ? Number(m[1]) : 0;
    if (k < 1 || k > n) return { ok: false, reason: `Beat "${b.id}" does not belong to one of the ${n} chapters: a long script names its beats c1_..., c2_... after the chapter.` };
    if (k < last) return { ok: false, reason: `Beat "${b.id}" comes after a later chapter's beats; the beats must follow the chapters in order.` };
    if (k > last + 1) return { ok: false, reason: `Chapter ${last + 1} has no beats; every chapter needs at least one.` };
    groups[k - 1]!.push(b);
    last = k;
  }
  if (last < n) return { ok: false, reason: `Chapter ${last + 1} has no beats; every chapter needs at least one.` };

  const timed = beatTimings(a.beats, a.words, a.narrationS);
  const startOfBeat = new Map(timed.map((t) => [t.id, t.realStartS ?? t.estStartS]));
  // The whole video: the narration plus the short tail. NOT targetFrames(): that clamps to ONE code scene (90 s), and a long video is many of them.
  const totalFrames = Math.max(1, Math.ceil((a.narrationS + TAIL_S) * FPS - 1e-9));
  // Chapter k starts where its first beat starts; chapter 1 starts at 0. Frame boundaries are whole frames, so the chapters tile the video exactly.
  const starts = groups.map((g, i) => (i === 0 ? 0 : Math.round(startOfBeat.get(g[0]!.id)! * FPS)));
  for (let i = 1; i < n; i++) if (starts[i]! <= starts[i - 1]!) return { ok: false, reason: `Chapter ${i + 1} starts no later than chapter ${i}; the narration and the beats do not line up.` };
  if (starts[n - 1]! >= totalFrames) return { ok: false, reason: `Chapter ${n} would start after the video ends.` };
  const chapters: ChapterWindow[] = [];
  for (let i = 0; i < n; i++) {
    const startFrame = starts[i]!;
    const endFrame = i + 1 < n ? starts[i + 1]! : totalFrames;
    const frames = endFrame - startFrame;
    if (frames > TSX_MAX_FRAMES) return { ok: false, reason: `Chapter ${i + 1} is ${r3(frames / FPS)} seconds long; one code scene may run at most ${TSX_MAX_FRAMES / FPS} seconds. Split it into two chapters.` };
    const startS = startFrame / FPS;
    const endS = endFrame / FPS;
    const c = a.outline.chapters[i]!;
    chapters.push({
      index: i + 1,
      title: c.title,
      line: c.line,
      beats: groups[i]!,
      startS: r3(startS),
      endS: r3(endS),
      startFrame,
      frames,
      words: a.words.filter((w) => w.startS >= startS - 1e-9 && w.startS < endS - 1e-9).map((w) => ({ word: w.word, startS: r3(w.startS - startS), endS: r3(Math.min(w.endS, endS) - startS) })),
    });
  }
  return { ok: true, chapters, totalFrames };
}

/**
 * What a chapter's file was made from. The engine step saves a finished chapter under this fingerprint and skips the chapter on the next try when it
 * still matches: the beats (ids, words, pictures asked for), the exact times and frames, the look and the size. A new narration or script changes it.
 */
export function chapterFingerprint(c: ChapterWindow, extra: { style: string | null; orientation: "portrait" | "landscape" }): string {
  return sha256Hex(
    canonicalJson({
      index: c.index,
      title: c.title,
      beats: c.beats.map((b) => ({ id: b.id, text: b.text, visual: b.visual ?? null })),
      startFrame: c.startFrame,
      frames: c.frames,
      words: c.words.map((w) => [w.word, Math.round(w.startS * 100)]),
      style: extra.style,
      orientation: extra.orientation,
    }),
  );
}

/** A soft whoosh just before each chapter after the first (the picture dips through black there). Optional: a missing clip drops it, never fails the video. */
export function chapterSeamCues(chapters: readonly Pick<ChapterWindow, "index" | "startS">[]): { cues: { id: string; sound: string; atS: number; gainDb: number; optional: boolean }[] } {
  return {
    cues: chapters.filter((c) => c.index > 1).map((c) => ({ id: `seam-${c.index}`, sound: "whoosh-soft", atS: Math.max(0, r3(c.startS - SEAM_LEAD_S)), gainDb: -8, optional: true })),
  };
}
