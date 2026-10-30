// Pure timing/motion helpers (unit-tested; no Remotion imports).
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** How many items (of `total`) are visible at `frame`, one new item every `framesPer`, first at `start`. */
export function visibleCount(frame: number, framesPer: number, total: number, start = 0): number {
  if (framesPer <= 0) return total;
  return Math.max(0, Math.min(total, Math.floor((frame - start) / framesPer) + 1));
}

/** Typewriter: characters of a `length` string shown at `frame`, `framesPerChar` each, starting at `start`. */
export function typedChars(frame: number, start: number, framesPerChar: number, length: number): number {
  if (framesPerChar <= 0) return length;
  return Math.max(0, Math.min(length, Math.floor((frame - start) / framesPerChar)));
}

export type KenBurns = { zoomFrom: number; zoomTo: number; panX: number; panY: number };

/** Scale and translate (as fractions of the frame size) at `frame` of `total`. Pan eases from -pan to +pan. */
export function kenBurns(frame: number, total: number, k: KenBurns): { scale: number; x: number; y: number } {
  const t = total <= 1 ? 1 : clamp01(frame / (total - 1));
  return {
    scale: k.zoomFrom + (k.zoomTo - k.zoomFrom) * t,
    x: k.panX * (2 * t - 1),
    y: k.panY * (2 * t - 1),
  };
}

/** Opacity of chat message `index` in a sliding window: 1 until `windowSize` newer messages exist, then fades to 0 over `fadeFrames`. */
export function windowOpacity(frame: number, framesPer: number, index: number, windowSize: number, fadeFrames: number): number {
  const leaves = (index + windowSize) * framesPer;
  return 1 - clamp01((frame - leaves) / Math.max(1, fadeFrames));
/** Math steps shown at `frame`: one more every `framesPerStep`, the first at frame 0. */
export const mathReveal = (frame: number, framesPerStep: number, total: number): number => visibleCount(frame, framesPerStep, total);

/** Tally shown at `frame` for a final `count`, growing linearly over `growFrames` and rounded down. */
export function tallyAt(frame: number, growFrames: number, count: number): number {
  if (growFrames <= 0) return count;
  return Math.min(count, Math.max(0, Math.floor((count * frame) / growFrames)));
}
