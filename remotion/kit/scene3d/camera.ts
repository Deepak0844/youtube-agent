// Camera path across shots: one smooth glide, no stop-and-go. Pure maths.
// Each shot gives two poses (a start pose and a pushed-in end pose). The camera passes through them as a Hermite spline with
// monotone (Fritsch-Carlson) tangents: velocity is continuous at every key, including across shot cuts; no overshoot; rest at both ends.
import type { Scene3d, Scene3dShot } from "../../../src/shared/scene3d/schema";
import { focusBox } from "./bounds";
import type { V3 } from "./bounds";
import { clampAbove, frameBox } from "./framing";
import type { Safe } from "./framing";

export type Pose = { position: V3; target: V3 };
export type CamKey = { t: number; position: V3; target: V3 };

const lerp3 = (a: V3, b: V3, u: number): V3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];

/** Start and end pose of one shot (the end is pushed in towards the target by shot.push_in). */
export function shotPoses(scene: Pick<Scene3d, "world" | "elements">, shot: Scene3dShot, aspect: number, safe?: Safe): [Pose, Pose] {
  let base: Pose;
  if (shot.free) base = { position: shot.free.position, target: shot.free.target };
  else {
    const box = shot.focus === undefined ? null : focusBox(scene, shot.focus);
    if (!box) throw new Error(`shot "${shot.id}" has nothing to frame`);
    const f = frameBox({ box, yawDeg: shot.yaw_deg, pitchDeg: shot.pitch_deg, aspect, safe });
    base = { position: lerp3(f.target, f.position, shot.distance_mul), target: f.target };
  }
  const end: Pose = { position: lerp3(base.position, base.target, shot.push_in), target: base.target };
  return [base, end];
}

/** Keys at 30% and 70% of every shot (the drift inside a shot, then a long glide into the next one); holds before the first and after the last. */
export function cameraKeys(scene: Pick<Scene3d, "world" | "elements" | "shots">, aspect: number, safe?: Safe): CamKey[] {
  const keys: CamKey[] = [];
  let t0 = 0;
  for (const shot of scene.shots) {
    const [a, b] = shotPoses(scene, shot, aspect, safe);
    keys.push({ t: t0 + shot.duration_s * 0.3, ...a }, { t: t0 + shot.duration_s * 0.7, ...b });
    t0 += shot.duration_s;
  }
  return keys;
}

const hermite = (p0: number, p1: number, m0: number, m1: number, u: number, h: number): number => {
  const u2 = u * u;
  const u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * h * m0 + (-2 * u3 + 3 * u2) * p1 + (u3 - u2) * h * m1;
};

function sample(keys: readonly CamKey[], t: number, pick: (k: CamKey) => V3): V3 {
  const first = keys[0]!;
  const last = keys[keys.length - 1]!;
  if (t <= first.t) return [...pick(first)];
  if (t >= last.t) return [...pick(last)];
  let i = 1;
  while (keys[i]!.t < t) i++;
  const k0 = keys[i - 1]!;
  const k1 = keys[i]!;
  const h = k1.t - k0.t;
  const u = (t - k0.t) / h;
  const tangent = (j: number, axis: number): number => {
    if (j <= 0 || j >= keys.length - 1) return 0; // at rest at the very ends
    // Monotone cubic (Fritsch-Carlson) tangent: the velocity is continuous everywhere, and the path never overshoots a key, so a long
    // move between shots cannot swing the camera through the scene.
    const h0 = keys[j]!.t - keys[j - 1]!.t;
    const h1 = keys[j + 1]!.t - keys[j]!.t;
    const d0 = (pick(keys[j]!)[axis]! - pick(keys[j - 1]!)[axis]!) / h0;
    const d1 = (pick(keys[j + 1]!)[axis]! - pick(keys[j]!)[axis]!) / h1;
    if (d0 * d1 <= 0) return 0;
    const w0 = 2 * h1 + h0;
    const w1 = h1 + 2 * h0;
    return (w0 + w1) / (w0 / d0 + w1 / d1);
  };
  const out = [0, 0, 0] as V3;
  for (let ax = 0; ax < 3; ax++) out[ax] = hermite(pick(k0)[ax]!, pick(k1)[ax]!, tangent(i - 1, ax), tangent(i, ax), u, h);
  return out;
}

/** Camera pose at time t. `minY` keeps the eye above ground/water (smoothly); `minY` can be a function of x, z. */
export function cameraAt(keys: readonly CamKey[], t: number, minY: number | ((x: number, z: number) => number) = -Infinity): Pose {
  const position = sample(keys, t, (k) => k.position);
  const target = sample(keys, t, (k) => k.target);
  const floor = typeof minY === "function" ? minY(position[0], position[2]) : minY;
  if (Number.isFinite(floor)) position[1] = clampAbove(position[1], floor, 1.5);
  return { position, target };
}

/** Which shot is on screen at time t (seconds), with the time into it. */
export function shotAt(shots: readonly { duration_s: number }[], t: number): { index: number; local: number } {
  let acc = 0;
  for (let i = 0; i < shots.length; i++) {
    const d = shots[i]!.duration_s;
    if (t < acc + d || i === shots.length - 1) return { index: i, local: t - acc };
    acc += d;
  }
  return { index: 0, local: 0 };
}

/** Video length in frames for a scene. */
export const scene3dFrames = (scene: { shots: readonly { duration_s: number }[]; fps: number }): number => Math.max(1, Math.round(scene.shots.reduce((a, s) => a + s.duration_s, 0) * scene.fps));
