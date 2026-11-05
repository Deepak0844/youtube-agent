// Camera maths for the rig: portrait-aware framing of a focus box, a coverage report, the glide timing and the hero lock.
// Pure functions. The spline itself (monotone, no stop-and-go) and the box fitting are reused from ../scene3d, not copied.
import { cameraAt, type CamKey, type Pose } from "../scene3d/camera";
import { boxCenter, type Box, type V3 } from "../scene3d/bounds";
import { clampAbove, corners, FOV_DEG, frameBox, project, safeFor, SAFE_PORTRAIT, SAFE_WIDE, type Safe } from "../scene3d/framing";
import { clamp, lerp, smooth } from "./rng";

export { cameraAt, FOV_DEG, SAFE_PORTRAIT, SAFE_WIDE, safeFor };
export type { Box, CamKey, Pose, Safe, V3 };

/** How much of the safe rectangle (the frame minus the caption margin) the box covers. */
export type Coverage = {
  /** Every corner of the box is inside the safe rectangle and in front of the camera. */
  fits: boolean;
  /** Share of the safe width and height the box spans, 0..1+ (1 = touches both sides). */
  width: number; height: number;
  /** The larger of the two: how "full" the shot is. Aim for 0.7..1 for a hero shot, 0.3..0.6 for an establishing one. */
  fill: number;
};

export function coverage(box: Box, eye: V3, target: V3, aspect: number, safe: Safe = safeFor(aspect), fovDeg = FOV_DEG): Coverage {
  const pts = project(corners(box), eye, target, fovDeg, aspect);
  const inFront = pts.every((p) => p.depth > 0.1);
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const safeW = 2 - 2 * (safe.left + safe.right), safeH = 2 - 2 * (safe.top + safe.bottom);
  const x0 = -1 + 2 * safe.left, x1 = 1 - 2 * safe.right, y0 = -1 + 2 * safe.bottom, y1 = 1 - 2 * safe.top;
  const width = (Math.max(...xs) - Math.min(...xs)) / safeW;
  const height = (Math.max(...ys) - Math.min(...ys)) / safeH;
  const inside = pts.every((p) => p.x >= x0 - 1e-6 && p.x <= x1 + 1e-6 && p.y >= y0 - 1e-6 && p.y <= y1 + 1e-6);
  return { fits: inFront && inside, width, height, fill: Math.max(width, height) };
}

export type FrameInput = {
  box: Box;
  /** Where the camera stands: 0 = on +z looking at -z, 90 = on +x. */
  yawDeg: number;
  /** How high above the horizon (0..80). Raised automatically if the eye would sink below `minY`. */
  pitchDeg: number;
  aspect: number;
  safe?: Safe;
  fovDeg?: number;
  /** The eye must stay above this height (ground or water level + margin). */
  minY?: number;
  /** 1 = the nearest camera that fits the box; >1 pulls back. */
  distanceMul?: number;
};
export type Framed = { position: V3; target: V3; coverage: Coverage; pitchDeg: number };

/** The nearest camera along yaw/pitch from which the whole box sits inside the safe area (caption margin on top in portrait). Never below `minY`. */
export function frameFocus(i: FrameInput): Framed {
  const fov = i.fovDeg ?? FOV_DEG;
  const safe = i.safe ?? safeFor(i.aspect);
  let pitch = clamp(i.pitchDeg, 0, 80);
  let f = frameBox({ box: i.box, yawDeg: i.yawDeg, pitchDeg: pitch, aspect: i.aspect, fovDeg: fov, safe });
  while (i.minY !== undefined && f.position[1] < i.minY && pitch < 80) {
    pitch = Math.min(80, pitch + 2);
    f = frameBox({ box: i.box, yawDeg: i.yawDeg, pitchDeg: pitch, aspect: i.aspect, fovDeg: fov, safe });
  }
  const mul = i.distanceMul ?? 1;
  const c = f.target;
  const position: V3 = [c[0] + (f.position[0] - c[0]) * mul, c[1] + (f.position[1] - c[1]) * mul, c[2] + (f.position[2] - c[2]) * mul];
  return { position, target: c, coverage: coverage(i.box, position, c, i.aspect, safe, fov), pitchDeg: pitch };
}

/** A camera key: an explicit pose at time t, or a box to frame (`frame`), resolved for the video's aspect ratio. */
export type RigShot =
  | { t: number; at: V3; look: V3 }
  | { t: number; frame: { box: Box; yawDeg: number; pitchDeg: number; distanceMul?: number } };

export type ResolvedShot = { key: CamKey; coverage: Coverage | null };

/** Resolves rig shots to spline keys. Times must increase. */
export function resolveShots(shots: readonly RigShot[], aspect: number, opt: { safe?: Safe; minY?: number; fovDeg?: number } = {}): ResolvedShot[] {
  shots.forEach((s, i) => { if (i > 0 && !(s.t > shots[i - 1]!.t)) throw new Error(`camera shot ${i}: t must be greater than the previous shot's t`); });
  return shots.map((s) => {
    if ("at" in s) return { key: { t: s.t, position: s.at, target: s.look }, coverage: null };
    const f = frameFocus({ ...s.frame, aspect, safe: opt.safe, minY: opt.minY, fovDeg: opt.fovDeg });
    return { key: { t: s.t, position: f.position, target: f.target }, coverage: f.coverage };
  });
}

/** Times for n keys across `duration` seconds that reproduce the proof's gentle start and end (a half-linear, half-smooth ease). Pure. */
export function glideTimes(n: number, duration: number): number[] {
  const ease = (x: number) => { const u = clamp(x); return u * 0.55 + smooth3(u) * 0.45; };
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const target = n === 1 ? 0 : i / (n - 1);
    let lo = 0, hi = 1;
    for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (ease(m) < target) lo = m; else hi = m; }
    out.push(((lo + hi) / 2) * duration);
  }
  return out;
}
const smooth3 = (x: number) => x * x * (3 - 2 * x);

/** A hero lock: the camera's look-at point leans towards a moving object between `from` and `to` seconds (strength 0..1), easing in and out over `fade` seconds. */
export type HeroLock = { at: (t: number) => V3; from: number; to: number; strength?: number; fade?: number };
export const heroWeight = (t: number, h: Pick<HeroLock, "from" | "to" | "strength" | "fade">): number => {
  const fade = Math.max(0.01, h.fade ?? 0.8);
  return clamp(h.strength ?? 1) * smooth((t - h.from) / fade) * smooth((h.to - t) / fade);
};

/** Camera pose at time t: the spline through the keys, kept above `floor` (a height or a function of x, z), look-at pulled to the hero if locked. */
export function rigPose(keys: readonly CamKey[], t: number, floor: number | ((x: number, z: number) => number) = -Infinity, hero?: HeroLock): Pose {
  const pose = cameraAt(keys, t, floor);
  if (hero) {
    const w = heroWeight(t, hero);
    if (w > 0) {
      const h = hero.at(t);
      pose.target = [lerp(pose.target[0], h[0], w), lerp(pose.target[1], h[1], w), lerp(pose.target[2], h[2], w)];
    }
  }
  return pose;
}

export { boxCenter, clampAbove };
