// Pure animation maths for scene format v2: easing, and what each element's animations say about it at time t.
// No runtime imports (the render container loads this file); types come from the schema.
import type { Ease, Scene3dAnimation, Scene3d } from "../../../src/shared/scene3d/schema";

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const BACK = 1.70158;

/** Easing curves on 0..1. back_out overshoots a little (a pop). */
export function ease(kind: Ease, x: number): number {
  const u = clamp01(x);
  switch (kind) {
    case "linear": return u;
    case "in": return u * u * u;
    case "out": return 1 - (1 - u) ** 3;
    case "in_out": return u * u * u * (u * (u * 6 - 15) + 10);
    case "back_out": return 1 + (BACK + 1) * (u - 1) ** 3 + BACK * (u - 1) ** 2;
  }
}

/** Progress 0..1 of an animation at time t (before it starts 0, after it ends 1), eased. */
export const progressOf = (a: { start_s: number; duration_s: number; ease: Ease }, t: number): number => ease(a.ease, (t - a.start_s) / a.duration_s);

/** Point at fraction u (0..1) of the arc length of a polyline, plus the heading (radians about Y, forward = +x) of the segment it is on. */
export function pointOnPath(path: readonly (readonly [number, number])[], u: number): { x: number; z: number; heading: number } {
  const lens: number[] = [];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const l = Math.hypot(path[i]![0] - path[i - 1]![0], path[i]![1] - path[i - 1]![1]);
    lens.push(l);
    total += l;
  }
  let d = clamp01(u) * total;
  for (let i = 0; i < lens.length; i++) {
    if (d <= lens[i]! || i === lens.length - 1) {
      const f = lens[i]! > 0 ? Math.min(1, d / lens[i]!) : 0;
      const a = path[i]!;
      const b = path[i + 1]!;
      return { x: a[0] + (b[0] - a[0]) * f, z: a[1] + (b[1] - a[1]) * f, heading: Math.atan2(-(b[1] - a[1]), b[0] - a[0]) };
    }
    d -= lens[i]!;
  }
  return { x: path[0]![0], z: path[0]![1], heading: 0 };
}

export type AnimState = {
  /** Set when a path moves the element (overrides the placement x/z). */
  x: number | null;
  z: number | null;
  /** Extra yaw in radians. */
  yaw: number;
  /** Scale multiplier. */
  scale: number;
  /** 0..1: how much has risen out of the ground (1 = fully built). */
  build: number;
  /** 0..1 pour progress, null when the element has no pour. */
  pour: number | null;
  pourFrom: [number, number, number] | null;
};

export const REST: AnimState = { x: null, z: null, yaw: 0, scale: 1, build: 1, pour: null, pourFrom: null };

/** Combines every animation of an element at time t (seconds). Order in the list does not matter. */
export function animAt(anims: readonly Scene3dAnimation[], t: number): AnimState {
  const s: AnimState = { ...REST };
  for (const a of anims) {
    const p = progressOf(a, t);
    switch (a.type) {
      case "move_along_path": {
        const pt = pointOnPath(a.path, p);
        s.x = pt.x;
        s.z = pt.z;
        if (a.face_direction) s.yaw += pt.heading;
        break;
      }
      case "rotate": s.yaw += (a.degrees * Math.PI / 180) * p; break;
      case "grow": s.scale *= a.from_scale + (1 - a.from_scale) * p; break;
      case "build_up": s.build = Math.min(s.build, p); break;
      case "pour": s.pour = p; s.pourFrom = [...a.from]; break;
    }
  }
  return s;
}

/** Height of the ground at (x, z): the highest terrain patch or slab top under it, else the world ground level. Used for snap-to-ground.
 *  A terrain patch is centred on its placement and its top is placement y + height_m. A strata slab spans x from its placement to x + width,
 *  is centred on z, and its top is the placement y. */
export function groundHeightAt(scene: Pick<Scene3d, "world" | "elements">, x: number, z: number): number {
  let h = scene.world.ground.kind === "none" ? -Infinity : scene.world.ground.y;
  for (const e of scene.elements) {
    if (e.kind === "terrain") {
      if (Math.abs(x - e.at.x) <= e.size_m[0] / 2 && Math.abs(z - e.at.z) <= e.size_m[1] / 2) h = Math.max(h, (e.at.y ?? 0) + e.height_m);
    } else if (e.kind === "strata_cut") {
      if (x >= e.at.x && x <= e.at.x + e.size_m[0] && Math.abs(z - e.at.z) <= e.size_m[2] / 2) h = Math.max(h, e.at.y ?? 0);
    }
  }
  return h === -Infinity ? 0 : h;
}
