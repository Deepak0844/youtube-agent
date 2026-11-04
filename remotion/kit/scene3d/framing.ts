// Portrait-aware shot framing: place a camera so a box fits inside a safe area (margins for captions). Pure maths, no imports at runtime.
import type { Box, V3 } from "./bounds";
import { boxCenter } from "./bounds";

export const FOV_DEG = 40;
export type Safe = { top: number; bottom: number; left: number; right: number };
/** Margins as fractions of the frame. Top is large because the caption pill sits there. */
export const SAFE_PORTRAIT: Safe = { top: 0.24, bottom: 0.1, left: 0.06, right: 0.06 };
export const SAFE_WIDE: Safe = { top: 0.14, bottom: 0.12, left: 0.08, right: 0.08 };
export const safeFor = (aspect: number): Safe => (aspect < 1 ? SAFE_PORTRAIT : SAFE_WIDE);

const rad = (d: number) => (d * Math.PI) / 180;
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Unit vector from the target towards the camera for a yaw (0 = camera on +z looking at -z) and pitch (above the horizon). */
export const viewDir = (yawDeg: number, pitchDeg: number): V3 => {
  const y = rad(yawDeg);
  const p = rad(pitchDeg);
  return [Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)];
};

export const corners = (b: Box): V3[] => {
  const out: V3[] = [];
  for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) out.push([x, y, z]);
  return out;
};

/** Projects world points for a camera at `eye` looking at `target`: x/y in -1..1 (y up), plus depth in front of the camera. */
export function project(points: readonly V3[], eye: V3, target: V3, fovDeg: number, aspect: number): { x: number; y: number; depth: number }[] {
  const f = norm(sub(target, eye));
  const r = norm(cross(f, [0, 1, 0]));
  const u = cross(r, f);
  const th = Math.tan(rad(fovDeg) / 2);
  return points.map((p) => {
    const d = sub(p, eye);
    const depth = dot(d, f);
    return { x: dot(d, r) / (depth * th * aspect), y: dot(d, u) / (depth * th), depth };
  });
}

/** True when every corner is in front of the camera and inside the safe rectangle. */
export function fits(box: Box, eye: V3, target: V3, fovDeg: number, aspect: number, safe: Safe): boolean {
  const lo = { x: -1 + 2 * safe.left, x1: 1 - 2 * safe.right, y0: -1 + 2 * safe.bottom, y1: 1 - 2 * safe.top };
  return project(corners(box), eye, target, fovDeg, aspect).every((p) => p.depth > 0.1 && p.x >= lo.x && p.x <= lo.x1 && p.y >= lo.y0 && p.y <= lo.y1);
}

export type FramingInput = { box: Box; yawDeg: number; pitchDeg: number; aspect: number; fovDeg?: number; safe?: Safe };
export type Framing = { position: V3; target: V3; distance: number };

/** The nearest camera along the view direction from which the whole box sits in the safe area. The look-at point is shifted so the box is centred in the safe rectangle, not in the frame. */
export function frameBox(i: FramingInput): Framing {
  const fov = i.fovDeg ?? FOV_DEG;
  const safe = i.safe ?? safeFor(i.aspect);
  const c = boxCenter(i.box);
  const dir = viewDir(i.yawDeg, i.pitchDeg);
  // The safe rectangle's centre sits below the frame centre when the top margin is bigger; aiming above the box centre puts the box there.
  const shiftY = safe.top - safe.bottom;
  const make = (d: number): { eye: V3; tgt: V3 } => {
    const eye: V3 = [c[0] + dir[0] * d, c[1] + dir[1] * d, c[2] + dir[2] * d];
    // Move the target along the camera's up axis so the centre lands mid safe area (small-angle, exact enough because the loop below re-checks fit).
    const f = norm(sub(c, eye));
    const r = norm(cross(f, [0, 1, 0]));
    const u = cross(r, f);
    const off = shiftY * d * Math.tan(rad(fov) / 2);
    return { eye, tgt: [c[0] + u[0] * off, c[1] + u[1] * off, c[2] + u[2] * off] };
  };
  let lo = 0.5;
  let hi = 1;
  while (hi < 1e6) { const m = make(hi); if (fits(i.box, m.eye, m.tgt, fov, i.aspect, safe)) break; lo = hi; hi *= 2; }
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    const m = make(mid);
    if (fits(i.box, m.eye, m.tgt, fov, i.aspect, safe)) hi = mid; else lo = mid;
  }
  const m = make(hi);
  return { position: m.eye, target: m.tgt, distance: hi };
}

/** Smooth max(y, minY): always at or above minY and bending gently (k metres) instead of kinking, so the camera glides over ground and water. */
export function clampAbove(y: number, minY: number, k = 2): number {
  const d = y - minY;
  return minY + (d + Math.sqrt(d * d + k * k)) / 2;
}
