import { z } from "zod";

// Deterministic checks of the preview pictures of an AI-written 3D scene (Phase 5e slice 3). Pure: no IO, no model. The caller decodes
// each PNG to raw RGB (src/server/render/still-pixels.ts) and hands the bytes here. Every threshold is a named constant below, and every
// problem is ONE plain sentence made by this code (never copied from a model), so it can safely go into the next prompt as it is.

export const LOOK_THRESHOLDS = {
  /** Pixel luminance spread (0-255) under this, or one colour taking more than FLAT_DOMINANT of the picture: a flat, empty frame. */
  FLAT_STD: 7,
  FLAT_DOMINANT: 0.9,
  /** Share of near-white pixels (every channel >= 225) over this: a white void, nothing to stand on. */
  VOID_LIGHT_SHARE: 0.55,
  /** Share of near-black pixels (every channel <= 30) over this: a black void. */
  VOID_DARK_SHARE: 0.7,
  /** The middle band (where the subject and the caption-free part of the picture are): one colour taking more than this share = empty middle. */
  MIDDLE_DOMINANT: 0.85,
  /** ...in at least this share of the pictures (a build-up that starts bare is fine for a frame or two). */
  MIDDLE_MIN_SHARE: 0.5,
  /** Subject cut off at a side edge: a thin strip along that edge, in the upper part of the picture, differs strongly from the top corner colour, and the opposite edge does not. */
  EDGE_DIFF: 170,
  EDGE_SHARE: 0.45,
  /** The hero (from the scene's <Hero>) must be at least this share of the frame width, in at least half of the pictures. A tall, thin hero (a crane) counts by its height: height x HERO_HEIGHT_TO_WIDTH is its width-equivalent in a portrait frame. */
  HERO_MIN_WIDTH: 0.2,
  HERO_MIN_SHARE: 0.5,
  HERO_HEIGHT_TO_WIDTH: 0.5625,
  /** The hero is cut off by the frame in this many pictures or more. */
  HERO_CLIPPED_MIN_FRAMES: 2,
  /** A hero under this share of the frame HEIGHT (in at least HERO_MIN_SHARE of the pictures) is a thin strip on a phone: a long row of small parts seen from far away. */
  HERO_MIN_HEIGHT: 0.12,
  /** The hero's width and height both stay within this range across every picture (with at least SAME_SHOT_MIN_FRAMES pictures): the camera never moves in, so the beats look the same. */
  SAME_SHOT_RANGE: 0.06,
  SAME_SHOT_MIN_FRAMES: 4,
} as const;

export const MAX_LOOK_PROBLEMS = 8;

export interface RawPicture {
  /** RGB, 3 bytes per pixel, row by row. */
  data: Uint8Array;
  width: number;
  height: number;
}

export interface StillMetrics {
  meanLum: number;
  stdLum: number;
  /** Share of the picture taken by its most common colour (colours rounded to 8 steps a channel). */
  dominantShare: number;
  lightShare: number;
  darkShare: number;
  middleDominantShare: number;
  /** Share of the left / right edge strip that differs strongly from the colour in the nearest top corner. */
  edgeLeft: number;
  edgeRight: number;
}

const bucket = (r: number, g: number, b: number): number => ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
const r3 = (n: number) => Math.round(n * 1000) / 1000;

function topShare(counts: Uint32Array, total: number): number {
  let top = 0;
  for (const c of counts) if (c > top) top = c;
  return total > 0 ? top / total : 0;
}

/** Numbers about one picture. Looks at every second pixel in both directions. */
export function stillMetrics(p: RawPicture): StillMetrics {
  const { data, width: w, height: h } = p;
  if (data.length < w * h * 3 || w < 8 || h < 8) throw new RangeError("picture is too small or its bytes are short");
  const all = new Uint32Array(512), mid = new Uint32Array(512);
  let n = 0, sum = 0, sum2 = 0, light = 0, dark = 0, midN = 0;
  const x0 = Math.floor(w * 0.08), x1 = Math.floor(w * 0.92), y0 = Math.floor(h * 0.3), y1 = Math.floor(h * 0.75);
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 3;
      const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      n++; sum += lum; sum2 += lum * lum;
      if (r >= 225 && g >= 225 && b >= 225) light++;
      if (r <= 30 && g <= 30 && b <= 30) dark++;
      const k = bucket(r, g, b);
      all[k]!++;
      if (x >= x0 && x < x1 && y >= y0 && y < y1) { mid[k]!++; midN++; }
    }
  }
  const mean = sum / n;
  const corner = (cx: number): [number, number, number] => {
    let r = 0, g = 0, b = 0, c = 0;
    for (let y = 0; y < Math.max(2, Math.floor(h * 0.04)); y++) {
      for (let x = cx; x < cx + Math.max(2, Math.floor(w * 0.06)); x++) { const i = (y * w + x) * 3; r += data[i]!; g += data[i + 1]!; b += data[i + 2]!; c++; }
    }
    return [r / c, g / c, b / c];
  };
  const strip = (xa: number, xb: number, ref: [number, number, number]): number => {
    let diff = 0, c = 0;
    for (let y = Math.floor(h * 0.12); y < Math.floor(h * 0.45); y += 2) {
      for (let x = xa; x < xb; x++) {
        const i = (y * w + x) * 3;
        if (Math.abs(data[i]! - ref[0]) + Math.abs(data[i + 1]! - ref[1]) + Math.abs(data[i + 2]! - ref[2]) > LOOK_THRESHOLDS.EDGE_DIFF) diff++;
        c++;
      }
    }
    return c > 0 ? diff / c : 0;
  };
  const edge = Math.max(2, Math.floor(w * 0.02));
  return {
    meanLum: r3(mean),
    stdLum: r3(Math.sqrt(Math.max(0, sum2 / n - mean * mean))),
    dominantShare: r3(topShare(all, n)),
    lightShare: r3(light / n),
    darkShare: r3(dark / n),
    middleDominantShare: r3(topShare(mid, midN)),
    edgeLeft: r3(strip(0, edge, corner(0))),
    edgeRight: r3(strip(w - edge, w, corner(w - Math.max(2, Math.floor(w * 0.06))))),
  };
}

/** Where the scene's <Hero> sat in one picture (written by the renderer next to the picture), or declared:false when no <Hero> reported. */
export const heroReportSchema = z.union([
  z.object({ declared: z.literal(false) }),
  z.object({ declared: z.literal(true), width: z.number().min(0).max(4), height: z.number().min(0).max(4), clipped: z.boolean() }),
]);
export type HeroReport = z.infer<typeof heroReportSchema>;

/** "Frame 3", "Frames 2 and 5", "Frames 1, 2 and 4" from 0-based indexes. */
export function framesPhrase(idx: readonly number[]): string {
  const n = idx.map((i) => String(i + 1));
  if (n.length === 1) return `Frame ${n[0]}`;
  return `Frames ${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
}
const are = (idx: readonly number[]) => (idx.length === 1 ? "is" : "are");
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * The problems of a set of pictures, as plain sentences made here (at most 8). `hero` has one entry per picture, or is null when the
 * renderer gave no hero data at all (then the hero checks are skipped, not failed).
 */
export function lookProblems(metrics: readonly StillMetrics[], hero: ReadonlyArray<HeroReport | null> | null): string[] {
  const T = LOOK_THRESHOLDS;
  const pick = (f: (m: StillMetrics, i: number) => boolean) => metrics.flatMap((m, i) => (f(m, i) ? [i] : []));
  const out: string[] = [];
  const isWhite = (m: StillMetrics) => m.lightShare > T.VOID_LIGHT_SHARE, isBlack = (m: StillMetrics) => m.darkShare > T.VOID_DARK_SHARE;
  const flat = pick((m) => !isWhite(m) && !isBlack(m) && (m.stdLum < T.FLAT_STD || m.dominantShare > T.FLAT_DOMINANT));
  if (flat.length) out.push(`${framesPhrase(flat)} ${are(flat)} almost one flat colour: there is nothing to see.`);
  const white = pick(isWhite);
  if (white.length) out.push(`${framesPhrase(white)} show${white.length === 1 ? "s" : ""} mostly empty white background: no ground or horizon. Add a ground or sea that reaches the horizon.`);
  const black = pick(isBlack);
  if (black.length) out.push(`${framesPhrase(black)} show${black.length === 1 ? "s" : ""} mostly empty black background: no ground or horizon. Light the scene and add a ground or sea.`);
  const empty = pick((m) => m.middleDominantShare > T.MIDDLE_DOMINANT).filter((i) => !flat.includes(i) && !white.includes(i) && !black.includes(i));
  if (empty.length >= Math.max(1, Math.ceil(metrics.length * T.MIDDLE_MIN_SHARE))) out.push(`The middle of ${lower(framesPhrase(empty))} is empty: the main subject is not there.`);
  // A subject cut off by the frame touches ONE side; a ground or sea that runs across the frame touches both, so a side counts only when the other is clear.
  const left = pick((m) => m.edgeLeft > T.EDGE_SHARE && m.edgeRight < T.EDGE_SHARE / 2), right = pick((m) => m.edgeRight > T.EDGE_SHARE && m.edgeLeft < T.EDGE_SHARE / 2);
  if (left.length) out.push(`The main subject looks cut off at the left edge in ${lower(framesPhrase(left))}.`);
  if (right.length) out.push(`The main subject looks cut off at the right edge in ${lower(framesPhrase(right))}.`);
  if (hero && hero.length > 0) {
    const reps = hero.map((h) => (h && h.declared ? h : null));
    const declared = reps.flatMap((h, i) => (h ? [i] : []));
    if (declared.length === 0) out.push("The scene does not mark a hero. Wrap the main subject in <Hero> so the pictures can be checked (it must fill 25 to 60 percent of the frame width).");
    else {
      const missing = reps.flatMap((h, i) => (h ? [] : [i]));
      if (missing.length) out.push(`The hero is not in ${lower(framesPhrase(missing))}.`);
      const small = declared.filter((i) => { const h = reps[i] as { width: number; height: number }; return Math.max(h.width, h.height * T.HERO_HEIGHT_TO_WIDTH) < T.HERO_MIN_WIDTH; });
      if (small.length >= Math.max(1, Math.ceil(declared.length * T.HERO_MIN_SHARE))) out.push(`The hero is too small in ${lower(framesPhrase(small))} (under 20 percent of the frame width). Make it bigger or move the camera closer.`);
      const thin = declared.filter((i) => !small.includes(i) && (reps[i] as { height: number }).height < T.HERO_MIN_HEIGHT);
      if (thin.length >= Math.max(1, Math.ceil(declared.length * T.HERO_MIN_SHARE))) out.push(`The hero is a thin strip in ${lower(framesPhrase(thin))} (under 12 percent of the frame height). Move the camera close to the part each beat talks about, or arrange the parts to fill more of the tall frame.`);
      const spread = (k: "width" | "height") => { const v = declared.map((i) => (reps[i] as { width: number; height: number })[k]); return Math.max(...v) - Math.min(...v); };
      if (declared.length >= T.SAME_SHOT_MIN_FRAMES && spread("width") <= T.SAME_SHOT_RANGE && spread("height") <= T.SAME_SHOT_RANGE) out.push("The hero is the same size in every picture: the camera never moves in. Give the beats different shots: close on the part each beat talks about, wide for the overview.");
      const cut = declared.filter((i) => (reps[i] as { clipped: boolean }).clipped);
      if (cut.length >= T.HERO_CLIPPED_MIN_FRAMES) out.push(`The hero is cut off by the edge of the picture in ${lower(framesPhrase(cut))}. Frame it so all of it fits.`);
    }
  }
  return out.slice(0, MAX_LOOK_PROBLEMS);
}
