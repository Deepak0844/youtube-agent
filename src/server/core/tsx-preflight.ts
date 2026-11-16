// TSX preflight (ADR 0009 guardrail 2): before any full render of a model-written scene, a few stills are rendered and
// checked here. A file can pass the static check and the type-check and still draw nothing, draw black, or never move.
// Pure functions over raw RGB buffers (3 bytes per pixel, row-major); no rendering here. Never throw.

const MAX_SIDE = 4096;
/** A pixel counts as black when every channel is at most this. */
const BLACK_LEVEL = 16;
/** A frame is black when at least this share of its pixels is black. */
const BLACK_SHARE = 0.995;
/** A frame is one flat colour when every channel's standard deviation is below this. */
const FLAT_STDDEV = 2;
/** A pixel changed between two frames when some channel moved by more than this. */
const CHANGE_LEVEL = 24;
/** Two frames differ when at least this share of pixels changed (about 1000 pixels of a 1080x1920 frame). */
const CHANGE_SHARE = 0.0005;

/** The objects zone as fractions of the frame height (360 to 1380 of 1920; the same zone the yt-kit layout uses). */
const ZONE_TOP = 360 / 1920;
const ZONE_BOTTOM = 1380 / 1920;
/** A pixel is an edge when a channel differs from its right or lower neighbour by more than this (soft glows and gradients stay below it). */
const EDGE_LEVEL = 24;
/** Frame 0 needs at least this share of edge pixels in the objects zone (measured: an empty gradient 0.0%, one big disc 0.5%, real scenes 0.8% to 8%). */
const EDGE_SHARE_MIN = 0.003;
/** The content area for the empty-band check, as fractions of the frame height (200 to 1650 of 1920: above the captions). */
const BAND_TOP = 200 / 1920;
const BAND_BOTTOM = 1650 / 1920;
/** The same two areas for a landscape (16:9) frame, as fractions of its height: the objects zone below the title, and the content area above the captions. */
const L_ZONE_TOP = 0.15;
const L_ZONE_BOTTOM = 0.75;
const L_BAND_TOP = 0.08;
const L_BAND_BOTTOM = 0.8;
/** The zone fractions for a frame: landscape when it is wider than tall. Portrait numbers are unchanged. */
const zoneOf = (f: RgbFrame) => (f.width > f.height ? { zt: L_ZONE_TOP, zb: L_ZONE_BOTTOM, bt: L_BAND_TOP, bb: L_BAND_BOTTOM } : { zt: ZONE_TOP, zb: ZONE_BOTTOM, bt: BAND_TOP, bb: BAND_BOTTOM });
/** A row is empty when fewer than this share of its pixels sit on an edge. */
const ROW_EDGE_MIN = 0.004;
/** The largest empty band of a frame's content area must stay under this share (measured: good scenes 0.15 to 0.36, an empty lower half 0.45 and more). */
export const EMPTY_BAND_MAX = 0.4;
/** The retry feedback for an empty first frame (rule + alternative). */
export const EMPTY_FRAME0 = "frame 0: objects zone looks empty; draw the hero objects at full strength from frame 0";

export interface RgbFrame {
  frame: number;
  width: number;
  height: number;
  rgb: Uint8Array;
}

/** Frames to sample for a scene of this length: first, middle and last (deduplicated). Empty for an unusable length. */
export function preflightFrames(durationInFrames: number): number[] {
  if (!Number.isInteger(durationInFrames) || durationInFrames < 1) return [];
  return [...new Set([0, Math.floor((durationInFrames - 1) / 2), durationInFrames - 1])];
}

/** Most stills one attempt renders for the frame review (the three preflight frames are always among them). */
export const REVIEW_STILLS_MAX = 8;

/**
 * Frames for the review: the preflight frames (first, middle, last) plus the beats' midpoints (frame numbers, any order, may
 * lie outside the scene), clamped to the scene, deduplicated, sorted and capped. When there are too many midpoints they are
 * thinned evenly; the preflight frames are never dropped.
 */
export function reviewStillFrames(durationInFrames: number, midpoints: readonly number[]): number[] {
  const base = preflightFrames(durationInFrames);
  if (base.length === 0) return [];
  const have = new Set(base);
  const extra = [...new Set(midpoints.filter((m) => Number.isFinite(m)).map((m) => Math.min(durationInFrames - 1, Math.max(0, Math.round(m)))))].filter((m) => !have.has(m)).sort((a, b) => a - b);
  const room = REVIEW_STILLS_MAX - base.length;
  const pick = extra.length <= room ? extra : Array.from({ length: room }, (_, i) => extra[Math.floor(((i + 0.5) * extra.length) / room)]!);
  return [...new Set([...base, ...pick])].sort((a, b) => a - b);
}

function validFrame(f: unknown): f is RgbFrame {
  if (!f || typeof f !== "object") return false;
  const { width, height, rgb, frame } = f as Partial<RgbFrame>;
  return Number.isInteger(frame) && Number.isInteger(width) && Number.isInteger(height) && width! > 0 && height! > 0 &&
    width! <= MAX_SIDE && height! <= MAX_SIDE && rgb instanceof Uint8Array && rgb.length === width! * height! * 3;
}

/** True when (almost) every pixel is black. */
export function isBlack(f: RgbFrame): boolean {
  const px = f.rgb.length / 3;
  let black = 0;
  for (let i = 0; i < f.rgb.length; i += 3) {
    if (f.rgb[i]! <= BLACK_LEVEL && f.rgb[i + 1]! <= BLACK_LEVEL && f.rgb[i + 2]! <= BLACK_LEVEL) black++;
  }
  return black >= px * BLACK_SHARE;
}

/** True when the frame is a single flat colour (blank). */
export function isFlat(f: RgbFrame): boolean {
  const px = f.rgb.length / 3;
  const sum = [0, 0, 0];
  const sq = [0, 0, 0];
  for (let i = 0; i < f.rgb.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      const v = f.rgb[i + c]!;
      sum[c]! += v;
      sq[c]! += v * v;
    }
  }
  return [0, 1, 2].every((c) => {
    const mean = sum[c]! / px;
    return Math.sqrt(Math.max(0, sq[c]! / px - mean * mean)) < FLAT_STDDEV;
  });
}

/** Share of pixels that changed between two frames of the same size (0..1), or null when the sizes differ. */
export function changedShare(a: RgbFrame, b: RgbFrame): number | null {
  if (a.width !== b.width || a.height !== b.height || a.rgb.length !== b.rgb.length) return null;
  let changed = 0;
  for (let i = 0; i < a.rgb.length; i += 3) {
    if (Math.abs(a.rgb[i]! - b.rgb[i]!) > CHANGE_LEVEL || Math.abs(a.rgb[i + 1]! - b.rgb[i + 1]!) > CHANGE_LEVEL || Math.abs(a.rgb[i + 2]! - b.rgb[i + 2]!) > CHANGE_LEVEL) changed++;
  }
  return changed / (a.rgb.length / 3);
}

/** Share of pixels in the objects zone that sit on a sharp edge (0..1). A plain gradient with a soft glow scores about 0. */
export function zoneEdgeShare(f: RgbFrame): number {
  const z = zoneOf(f);
  const y0 = Math.floor(f.height * z.zt);
  const y1 = Math.min(f.height - 1, Math.floor(f.height * z.zb));
  const step = Math.max(1, Math.round(f.width / 360)); // compare pixels a constant fraction of the width apart, whatever the resolution
  let edges = 0;
  let total = 0;
  for (let y = y0; y < y1 - step; y++) {
    for (let x = 0; x < f.width - step; x++) {
      const i = (y * f.width + x) * 3;
      const j = i + step * 3;
      const k = i + step * f.width * 3;
      let hit = false;
      for (let c = 0; c < 3 && !hit; c++) hit = Math.abs(f.rgb[i + c]! - f.rgb[j + c]!) > EDGE_LEVEL || Math.abs(f.rgb[i + c]! - f.rgb[k + c]!) > EDGE_LEVEL;
      if (hit) edges++;
      total++;
    }
  }
  return total === 0 ? 0 : edges / total;
}

/**
 * The share (0..1) of the content area taken by its largest run of rows with no sharp edge: how much of the picture's height
 * is an empty band. Soft glows and gradients do not count as content. 0 for an unusable frame. Never throws.
 */
export function longestEmptyBand(f: RgbFrame): number {
  try {
    if (!validFrame(f)) return 0;
    const z = zoneOf(f);
    const y0 = Math.floor(f.height * z.bt);
    const y1 = Math.min(f.height - 1, Math.floor(f.height * z.bb));
    if (y1 <= y0) return 0;
    const step = Math.max(1, Math.round(f.width / 360));
    let best = 0;
    let run = 0;
    for (let y = y0; y < y1; y++) {
      let edges = 0;
      for (let x = 0; x < f.width - step; x++) {
        const i = (y * f.width + x) * 3;
        const j = i + step * 3;
        const k = i + step * f.width * 3;
        let hit = false;
        for (let c = 0; c < 3 && !hit; c++) hit = Math.abs(f.rgb[i + c]! - f.rgb[j + c]!) > EDGE_LEVEL || (k + c < f.rgb.length && Math.abs(f.rgb[i + c]! - f.rgb[k + c]!) > EDGE_LEVEL);
        if (hit) edges++;
      }
      if (edges / f.width < ROW_EDGE_MIN) best = Math.max(best, ++run);
      else run = 0;
    }
    return best / (y1 - y0);
  } catch {
    return 0;
  }
}

/** Landscape captions sit at about 80% to 93% of the frame's height: sharp edges there mean a picture or label runs into them (measured: engine previews 0.0%, a frame whose object reached the captions 0.3% to 1%). */
const CAPTION_TOP = 0.8;
const CAPTION_BOTTOM = 0.95;
export const CAPTION_BAND_EDGE_MAX = 0.003;

/** Share (0..1) of the caption band's pixels on a sharp edge, for a landscape frame; 0 for a tall one (its captions are handled by the objects zone). */
export function captionBandEdgeShare(f: RgbFrame): number {
  try {
    if (!validFrame(f) || f.width <= f.height) return 0;
    const y0 = Math.floor(f.height * CAPTION_TOP);
    const y1 = Math.min(f.height - 1, Math.floor(f.height * CAPTION_BOTTOM));
    const step = Math.max(1, Math.round(f.width / 360));
    let edges = 0;
    let total = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < f.width - step; x++) {
        const i = (y * f.width + x) * 3;
        const j = i + step * 3;
        const k = i + step * f.width * 3;
        let hit = false;
        for (let c = 0; c < 3 && !hit; c++) hit = Math.abs(f.rgb[i + c]! - f.rgb[j + c]!) > EDGE_LEVEL || (k + c < f.rgb.length && Math.abs(f.rgb[i + c]! - f.rgb[k + c]!) > EDGE_LEVEL);
        if (hit) edges++;
        total++;
      }
    }
    return total === 0 ? 0 : edges / total;
  } catch {
    return 0;
  }
}

/**
 * Checks the sampled stills: each must be a readable frame of the expected size, not black and not one flat colour, and
 * (with two or more stills) at least one pair must differ, i.e. something moves. The last frame may equal frame 0 (a loop).
 */
export function checkPreflight(frames: unknown, size: { width: number; height: number }, opts: { maxEmptyBand?: number } = {}): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  try {
    if (!Array.isArray(frames) || frames.length === 0) return { ok: false, problems: ["No preview frames were rendered."] };
    const good: RgbFrame[] = [];
    for (const f of frames.slice(0, 10)) {
      if (!validFrame(f)) { problems.push("A preview frame could not be read."); continue; }
      if (f.width !== size.width || f.height !== size.height) { problems.push(`Frame ${f.frame} is ${f.width}x${f.height}, expected ${size.width}x${size.height}.`); continue; }
      if (isBlack(f)) problems.push(`Frame ${f.frame} is black.`);
      else if (isFlat(f)) problems.push(`Frame ${f.frame} is blank (one flat colour).`);
      else if (f.frame === 0 && zoneEdgeShare(f) < EDGE_SHARE_MIN) problems.push(EMPTY_FRAME0);
      else if (opts.maxEmptyBand !== undefined) {
        const band = longestEmptyBand(f);
        const cap = captionBandEdgeShare(f);
        if (cap > CAPTION_BAND_EDGE_MAX) problems.push(`Frame ${f.frame}: a picture or label runs into the caption band (the bottom 20% of the frame, where the captions go); keep everything above y ${Math.round(f.height * CAPTION_TOP)} of ${f.height}.`);
        if (band > opts.maxEmptyBand) problems.push(`Frame ${f.frame}: an empty band covers ${Math.round(band * 100)}% of the picture's height; spread the objects over the whole height (the largest empty band must stay under ${Math.round(opts.maxEmptyBand * 100)}%).`);
      }
      good.push(f);
    }
    if (problems.length === 0 && good.length >= 2) {
      const moves = good.some((a, i) => good.slice(i + 1).some((b) => (changedShare(a, b) ?? 0) >= CHANGE_SHARE));
      if (!moves) problems.push(`Frames ${good.map((f) => f.frame).join(", ")} look identical: nothing moves. Animate from useCurrentFrame().`);
    }
  } catch {
    problems.push("The preview frames could not be checked.");
  }
  return { ok: problems.length === 0, problems };
}
