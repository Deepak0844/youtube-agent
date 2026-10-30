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

export type AlgoStep = { at: number; type: "highlight" | "compare" | "swap" | "mark_done" | "pointer"; i: number; j?: number };

/** Board state at `ms` after replaying every step with at <= ms. swap exchanges values; the last highlight/compare/swap stays lit until a newer one or a pointer move. */
export function cellsAt(cells: readonly string[], steps: readonly AlgoStep[], ms: number) {
  const values = [...cells];
  let active: number[] = [];
  let pointer: number | null = null;
  const done: number[] = [];
  for (const s of steps) {
    if (s.at > ms) break;
    if (s.type === "pointer") {
      pointer = s.i;
      active = [];
    } else if (s.type === "mark_done") {
      if (!done.includes(s.i)) done.push(s.i);
    } else {
      active = s.j === undefined ? [s.i] : [s.i, s.j];
      if (s.type === "swap" && s.j !== undefined) {
        const t = values[s.i]!;
        values[s.i] = values[s.j]!;
        values[s.j] = t;
      }
    }
  }
  return { values, active, pointer, done };
}
