// Height field of everything that stands on the sea floor (land slabs, terrain, piles, ring walls) and how close each point is to it.
// The water block turns this into a texture: shallow colour, foam at the shore and caustic fade all read from it. Pure maths.
import type { Scene3d, Scene3dElement } from "../../../src/shared/scene3d/schema";
import { animAt } from "./anim";

type El = Scene3dElement;
const smooth = (u: number) => { const x = Math.min(1, Math.max(0, u)); return x * x * (3 - 2 * x); };

/** Radial profile of a ring wall across its width: [offset / width from the ring radius, height fraction, colour mix 0 sand .. 1 rubble]. */
export const RING_PROFILE: readonly (readonly [number, number, number])[] = [
  [-0.425, 0, 0], [-0.36, 0.75, 0], [-0.27, 1, 0.5], [0.3, 1, 1], [0.62, 0.3, 1], [1.06, 0, 0.6],
];
export const ringHeightFrac = (off: number): number => {
  const p = RING_PROFILE;
  if (off <= p[0]![0] || off >= p[p.length - 1]![0]) return 0;
  for (let i = 1; i < p.length; i++) if (off <= p[i]![0]) return p[i - 1]![1] + ((off - p[i - 1]![0]) / (p[i]![0] - p[i - 1]![0])) * (p[i]![1] - p[i - 1]![1]);
  return 0;
};

/** Is the angle (deg, measured as in the ring builder: counter-clockwise seen from above, 0 = +x) inside the arc? */
export const inArc = (deg: number, a0: number, a1: number): boolean => {
  const span = a1 - a0;
  if (span >= 360) return true;
  const d = (((deg - a0) % 360) + 360) % 360;
  return d <= span;
};

/** Surface height of one element at world (x, z) above its own base, or -Infinity when the point is outside it. `pour` = pile progress. */
export function solidTop(e: El, x: number, z: number, pour: number | null): number {
  const lx = x - e.at.x;
  const lz = z - e.at.z;
  const y0 = e.at.y ?? 0;
  switch (e.kind) {
    case "strata_cut": {
      const [w, h, d] = e.size_m;
      if (lx < 0 || lx > w || Math.abs(lz) > d / 2) return -Infinity;
      const flat = w - e.ramp_m;
      if (lx <= flat || e.ramp_m <= 0) return y0;
      return y0 - Math.min(h, e.ramp_m * 0.95) * ((lx - flat) / e.ramp_m);
    }
    case "terrain":
      return Math.abs(lx) <= e.size_m[0] / 2 && Math.abs(lz) <= e.size_m[1] / 2 ? y0 + e.height_m : -Infinity;
    case "sand_pile": {
      const p = pour ?? 1;
      const R = e.radius_m * e.at.scale * (0.35 + 0.65 * p);
      const r = Math.hypot(lx, lz);
      return r >= R ? -Infinity : y0 + e.height_m * e.at.scale * p * (1 - smooth(r / R)) ** 0.9;
    }
    case "rock_pile": {
      if (e.shape !== "ring") {
        const r = Math.hypot(lx, lz);
        return r >= e.radius_m ? -Infinity : y0 + e.height_m * (1 - smooth(r / e.radius_m)) * 0.8;
      }
      const ang = (Math.atan2(-lz, lx) * 180) / Math.PI;
      if (!inArc(ang, e.arc_deg[0], e.arc_deg[1])) return -Infinity;
      const f = ringHeightFrac((Math.hypot(lx, lz) - e.radius_m) / e.width_m);
      return f > 0 ? y0 + e.height_m * f : -Infinity;
    }
    default:
      return -Infinity;
  }
}

/** Horizontal distance from (x, z) to the footprint of an element (0 inside). */
export function footprintDist(e: El, x: number, z: number): number {
  const lx = x - e.at.x;
  const lz = z - e.at.z;
  switch (e.kind) {
    case "strata_cut": return Math.hypot(Math.max(0 - lx, 0, lx - e.size_m[0]), Math.max(Math.abs(lz) - e.size_m[2] / 2, 0));
    case "terrain": return Math.hypot(Math.max(Math.abs(lx) - e.size_m[0] / 2, 0), Math.max(Math.abs(lz) - e.size_m[1] / 2, 0));
    case "sand_pile": return Math.max(0, Math.hypot(lx, lz) - e.radius_m * e.at.scale);
    case "rock_pile": {
      if (e.shape !== "ring") return Math.max(0, Math.hypot(lx, lz) - e.radius_m);
      const ang = (Math.atan2(-lz, lx) * 180) / Math.PI;
      const rad = Math.abs(Math.hypot(lx, lz) - e.radius_m - e.width_m * 0.3) - e.width_m * 0.7;
      return inArc(ang, e.arc_deg[0], e.arc_deg[1]) ? Math.max(0, rad) : Math.max(0, rad) + 12;
    }
    default: return Infinity;
  }
}

export type WaterField = { w: number; h: number; data: Uint8Array<ArrayBuffer> };

/** RGBA8 field over the water's footprint: R = shore closeness 0..1, G = 255 where something dry/solid reaches the surface, B = depth / depth_m (to the highest solid under the point), A = 255. */
export function buildWaterField(scene: Pick<Scene3d, "elements">, water: Extract<El, { kind: "water" }>, t: number, w = 1024, h = 256): WaterField {
  const data = new Uint8Array(w * h * 4);
  const solids = scene.elements.filter((e) => e.kind === "strata_cut" || e.kind === "terrain" || e.kind === "sand_pile" || (e.kind === "rock_pile"));
  const pours = solids.map((e) => animAt(e.animations, t).pour);
  const [W, D] = water.size_m;
  const floor = water.level_y - water.depth_m;
  for (let j = 0; j < h; j++) {
    const z = water.at.z + (j / (h - 1) - 0.5) * D;
    for (let i = 0; i < w; i++) {
      const x = water.at.x + (i / (w - 1) - 0.5) * W;
      let top = floor;
      let near = Infinity;
      for (let k = 0; k < solids.length; k++) {
        const e = solids[k]!;
        const s = solidTop(e, x, z, pours[k]!);
        if (s > top) top = s;
        near = Math.min(near, footprintDist(e, x, z));
      }
      const o = (j * w + i) * 4;
      const depth = water.level_y - top;
      data[o] = Math.round(255 * Math.exp(-Math.min(near, 200) / 14));
      data[o + 1] = depth <= 0.02 ? 255 : 0;
      data[o + 2] = Math.round(255 * Math.min(1, Math.max(0, depth / water.depth_m)));
      data[o + 3] = 255;
    }
  }
  return { w, h, data };
}
