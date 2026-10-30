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
}

/** Math steps shown at `frame`: one more every `framesPerStep`, the first at frame 0. */
export const mathReveal = (frame: number, framesPerStep: number, total: number): number => visibleCount(frame, framesPerStep, total);

/** Tally shown at `frame` for a final `count`, growing linearly over `growFrames` and rounded down. */
export function tallyAt(frame: number, growFrames: number, count: number): number {
  if (growFrames <= 0) return count;
  return Math.min(count, Math.max(0, Math.floor((count * frame) / growFrames)));
}

/** A1-style cell or range ("B2", "A1:B3") to zero-based inclusive bounds, or null if malformed. */
export function cellRange(ref: string): { c1: number; r1: number; c2: number; r2: number } | null {
  const m = /^([A-Z])([1-9]\d*)(?::([A-Z])([1-9]\d*))?$/.exec(ref);
  if (!m) return null;
  const a = [m[1]!.charCodeAt(0) - 65, Number(m[2]) - 1];
  const b = m[3] ? [m[3].charCodeAt(0) - 65, Number(m[4]) - 1] : a;
  return { c1: Math.min(a[0]!, b[0]!), r1: Math.min(a[1]!, b[1]!), c2: Math.max(a[0]!, b[0]!), r2: Math.max(a[1]!, b[1]!) };
}

/** Round a max value up to a tidy axis top (1, 2, 5 x 10^n style steps of 1/2/5/10). Bad input gives 1. */
export function niceMax(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  const n = max / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

/** Each value as a fraction of the total (all zero when the total is not positive). */
export function pieSlices(values: number[]): number[] {
  const total = values.reduce((a, b) => a + b, 0);
  return values.map((v) => (total > 0 ? v / total : 0));
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

// ---- orbit ----
export type OrbitBody = { label: string; radius: number; periodS: number };
export type OrbitPreset = "solar_system" | "moon_earth" | "custom";

const PRESETS: Record<Exclude<OrbitPreset, "custom">, OrbitBody[]> = {
  solar_system: [
    { label: "Mercury", radius: 2, periodS: 4 },
    { label: "Venus", radius: 3.5, periodS: 7 },
    { label: "Earth", radius: 5, periodS: 10 },
    { label: "Mars", radius: 7, periodS: 15 },
    { label: "Jupiter", radius: 9.5, periodS: 30 },
  ],
  moon_earth: [{ label: "Moon", radius: 6, periodS: 8 }],
};

export function resolveBodies(preset: OrbitPreset, bodies: OrbitBody[] | undefined): OrbitBody[] {
  return preset === "custom" ? (bodies ?? []) : PRESETS[preset];
}

/** Position on an ellipse centred on the origin; one lap per `periodS` seconds. */
export function orbitPoint(frame: number, fps: number, periodS: number, rx: number, ry: number, phase = 0): [number, number] {
  const a = phase + (2 * Math.PI * frame) / (fps * periodS);
  return [rx * Math.cos(a), ry * Math.sin(a)];
}

// ---- map ----
/** [west, south, east, north] in degrees. */
export const REGIONS = {
  world: [-180, -58, 180, 80],
  europe: [-12, 35, 40, 71],
  north_america: [-170, 7, -50, 72],
  south_america: [-82, -56, -34, 13],
  africa: [-20, -35, 52, 38],
  asia: [25, -10, 150, 55],
  oceania: [110, -48, 180, 0],
} as const satisfies Record<string, readonly [number, number, number, number]>;
export type Region = keyof typeof REGIONS;

const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (Math.max(-85, Math.min(85, lat)) * Math.PI) / 360));

/** Mercator-project lon/lat into a w x h box, fitting the whole region and centring it. */
export function kitProject(region: Region, lon: number, lat: number, w: number, h: number): [number, number] {
  const [west, south, east, north] = REGIONS[region];
  const spanX = ((east - west) * Math.PI) / 180;
  const spanY = mercY(north) - mercY(south);
  const k = Math.min(w / spanX, h / spanY);
  const ox = (w - spanX * k) / 2;
  const oy = (h - spanY * k) / 2;
  return [ox + (((lon - west) * Math.PI) / 180) * k, oy + (mercY(north) - mercY(lat)) * k];
}

export function inRegion(region: Region, lon: number, lat: number): boolean {
  const [west, south, east, north] = REGIONS[region];
  return lon >= west && lon <= east && lat >= south && lat <= north;
}

export type LabelSlot = { x: number; y: number; anchor: "start" | "end" | "middle" };

/**
 * Label position for each marker: tries right, left, above, below and keeps the first that stays inside the box,
 * misses the route line, other markers and earlier labels. Falls back to "right". Positions are relative to the marker.
 */
export function placeLabels(pts: [number, number][], widths: number[], box: { w: number; h: number }, textH = 44, gap = 26): LabelSlot[] {
  type R = { l: number; t: number; r: number; b: number };
  const hit = (a: R, b: R) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
  const dots: R[] = pts.map(([x, y]) => ({ l: x - 16, r: x + 16, t: y - 16, b: y + 16 }));
  const placed: R[] = [];
  return pts.map(([px, py], i) => {
    const w = widths[i] ?? 0;
    const slots: { s: LabelSlot; r: R }[] = [
      { s: { x: gap, y: textH / 3, anchor: "start" }, r: { l: px + gap, r: px + gap + w, t: py - textH / 2, b: py + textH / 2 } },
      { s: { x: -gap, y: textH / 3, anchor: "end" }, r: { l: px - gap - w, r: px - gap, t: py - textH / 2, b: py + textH / 2 } },
      { s: { x: 0, y: -gap, anchor: "middle" }, r: { l: px - w / 2, r: px + w / 2, t: py - gap - textH, b: py - gap } },
      { s: { x: 0, y: gap + textH * 0.8, anchor: "middle" }, r: { l: px - w / 2, r: px + w / 2, t: py + gap, b: py + gap + textH } },
    ];
    const onRoute = (r: R) =>
      pts.slice(1).some(([x2, y2], k) => {
        const [x1, y1] = pts[k]!;
        return Array.from({ length: 41 }, (_, j) => j / 40).some((t) => {
          const x = x1 + (x2 - x1) * t;
          const y = y1 + (y2 - y1) * t;
          return x > r.l && x < r.r && y > r.t && y < r.b;
        });
      });
    const free = slots.find(({ r }) => r.l >= 0 && r.r <= box.w && r.t >= 0 && r.b <= box.h && !onRoute(r) && !dots.some((d, k) => k !== i && hit(r, d)) && !placed.some((p) => hit(r, p))) ?? slots[0]!;
    placed.push(free.r);
    return free.s;
  });
}
