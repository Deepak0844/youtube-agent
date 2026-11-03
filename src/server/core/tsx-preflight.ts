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
  const y0 = Math.floor(f.height * ZONE_TOP);
  const y1 = Math.min(f.height - 1, Math.floor(f.height * ZONE_BOTTOM));
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
 * Checks the sampled stills: each must be a readable frame of the expected size, not black and not one flat colour, and
 * (with two or more stills) at least one pair must differ, i.e. something moves. The last frame may equal frame 0 (a loop).
 */
export function checkPreflight(frames: unknown, size: { width: number; height: number }): { ok: boolean; problems: string[] } {
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
