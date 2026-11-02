// Pure timing helpers for KitScene / KitVideo / Captions. No Remotion imports.
export const msToFrame = (ms: number, fps: number): number => Math.round((ms * fps) / 1000);

type Span = { startMs: number; durationMs: number };

/** Sequence placement for one scene. A scene is never shorter than one frame. */
export function sceneRange(s: Span, fps: number): { from: number; duration: number } {
  return { from: msToFrame(s.startMs, fps), duration: Math.max(1, msToFrame(s.durationMs, fps)) };
}

/** Whole video length: the latest scene end. */
export function docFrames(scenes: readonly Span[], fps: number): number {
  return Math.max(1, ...scenes.map((s) => { const r = sceneRange(s, fps); return r.from + r.duration; }));
}

/** Clips by file extension; everything else (including data: pictures) is an image. */
export const mediaOf = (src: string): "image" | "video" => (/\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(src) ? "video" : "image");

/** Collage tile start frames: first at 0, each next one `enterFrames` + its delayMs after the previous. */
export function collageStarts(delaysMs: readonly number[], fps: number, enterFrames = 12): number[] {
  let at = 0;
  return delaysMs.map((d, i) => (i === 0 ? 0 : (at += enterFrames + msToFrame(d, fps))));
}

export type CaptionWord = { word: string; startS: number; endS: number; estimated?: boolean };

/** Index of the word being spoken at tS; stays on the last started word for `holdS` after it ends; -1 when none. */
export function currentWord(words: readonly CaptionWord[], tS: number, holdS = 0.4): number {
  let idx = -1;
  for (let i = 0; i < words.length; i++) {
    if (words[i]!.startS <= tS) idx = i;
    else break;
  }
  return idx >= 0 && tS <= words[idx]!.endS + holdS ? idx : -1;
}

/** Greedy line break: lines of word indexes, each line at most maxWidth by `measure` (a lone long word gets its own line). */
export function breakLines(words: readonly string[], maxWidth: number, measure: (text: string) => number): number[][] {
  const lines: number[][] = [];
  let cur: number[] = [];
  words.forEach((w, i) => {
    const next = cur.length ? `${cur.map((j) => words[j]).join(" ")} ${w}` : w;
    if (cur.length && measure(next) > maxWidth) {
      lines.push(cur);
      cur = [i];
    } else cur.push(i);
  });
  if (cur.length) lines.push(cur);
  return lines;
}

/** Caption pages: consecutive lines grouped `maxLines` at a time. Each page is a list of lines of word indexes. */
export function paginate(words: readonly string[], maxWidth: number, measure: (text: string) => number, maxLines: number): number[][][] {
  const lines = breakLines(words, maxWidth, measure);
  const pages: number[][][] = [];
  for (let i = 0; i < lines.length; i += maxLines) pages.push(lines.slice(i, i + maxLines));
  return pages;
}

/** The first scene's own clock starts this far in, so frame 0 shows entered objects, not an empty picture. */
export const INTRO_SKIP_FRAMES = 24;

/** Head start for the first scene: INTRO_SKIP_FRAMES, at most half that scene. */
export const introSkipFrames = (firstSceneFrames: number): number => Math.max(0, Math.min(INTRO_SKIP_FRAMES, Math.floor(firstSceneFrames / 2)));

/** Frames a scene fades in over the one before it. */
export const TRANSITION_FRAMES = 8;

/** Sequence length for a scene: the next scene fades in on top, so every scene but the last stays up that long under it. Timing is unchanged. */
export const sequenceFrames = (duration: number, isLast: boolean, frames = TRANSITION_FRAMES): number => (isLast ? duration : duration + frames);

/** Fade + short slide-up for a scene's first `frames` frames (the first scene has none). */
export function transitionIn(frame: number, frames = TRANSITION_FRAMES, rise = 48): { opacity: number; dy: number } {
  const t = Math.min(1, Math.max(0, frame / Math.max(1, frames)));
  return { opacity: t, dy: (1 - t) * rise };
}
