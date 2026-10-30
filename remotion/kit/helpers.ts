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

export type CollageLayout = "grid2" | "grid3" | "hero_plus_strip" | "stagger";
export type Rect = { x: number; y: number; w: number; h: number };
export type CollageEnter = "fade" | "pop" | "slide_left" | "slide_right" | "rise";

/** Tile rectangles (px) for `n` tiles, all inside `box` (the safe area), `gap` apart. Extra tiles share the last slot pattern. */
export function collageRects(layout: CollageLayout, n: number, box: Rect, gap = 24): Rect[] {
  const out: Rect[] = [];
  const cell = (cols: number, rows: number, i: number): Rect => {
    const w = (box.w - gap * (cols - 1)) / cols;
    const h = (box.h - gap * (rows - 1)) / rows;
    return { x: box.x + (i % cols) * (w + gap), y: box.y + Math.floor(i / cols) * (h + gap), w, h };
  };
  if (layout === "grid2") {
    const rows = Math.ceil(n / 2);
    for (let i = 0; i < n; i++) out.push(cell(2, rows, i));
  } else if (layout === "grid3") {
    const rows = Math.ceil(n / 3);
    for (let i = 0; i < n; i++) out.push(cell(3, rows, i));
  } else if (layout === "hero_plus_strip") {
    // Big tile on top (60%), the rest in a row below.
    const heroH = (box.h - gap) * 0.6;
    out.push({ x: box.x, y: box.y, w: box.w, h: heroH });
    const k = n - 1;
    const w = (box.w - gap * (k - 1)) / k;
    const h = box.h - gap - heroH;
    for (let i = 0; i < k; i++) out.push({ x: box.x + i * (w + gap), y: box.y + heroH + gap, w, h });
  } else {
    // Stagger: two columns, right column shifted down; stays inside the box.
    const rows = Math.ceil(n / 2);
    const shift = 120;
    const w = (box.w - gap) / 2;
    const h = (box.h - shift - gap * (rows - 1)) / rows;
    for (let i = 0; i < n; i++) {
      const col = i % 2;
      out.push({ x: box.x + col * (w + gap), y: box.y + (col ? shift : 0) + Math.floor(i / 2) * (h + gap), w, h });
    }
  }
  return out;
}

/** Entrance state at `frame` for a tile starting at `start`, taking `dur` frames. */
export function enterState(enter: CollageEnter, frame: number, start: number, dur = 12): { opacity: number; x: number; y: number; scale: number } {
  const t = dur <= 0 ? 1 : clamp01((frame - start) / dur);
  const e = 1 - (1 - t) ** 3; // ease out
  const rest = { opacity: e, x: 0, y: 0, scale: 1 };
  if (enter === "pop") return { ...rest, scale: 0.8 + 0.2 * e };
  if (enter === "slide_left") return { ...rest, x: -120 * (1 - e) };
  if (enter === "slide_right") return { ...rest, x: 120 * (1 - e) };
  if (enter === "rise") return { ...rest, y: 120 * (1 - e) };
  return rest;
}
