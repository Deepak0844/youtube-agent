// Axis-aligned boxes (world metres) for scene elements: what the camera frames. Pure maths.
import type { Scene3d, Scene3dElement } from "../../../src/shared/scene3d/schema";
import { groundHeightAt } from "./anim";

export type V3 = [number, number, number];
export type Box = { min: V3; max: V3 };

export const unionBox = (a: Box, b: Box): Box => ({
  min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
  max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
});
export const boxCenter = (b: Box): V3 => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
export const boxSize = (b: Box): V3 => [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];

/** Base height an element stands on. */
export function baseY(scene: Pick<Scene3d, "world" | "elements">, e: Scene3dElement): number {
  if (e.at.y !== undefined) return e.at.y;
  return e.at.snap ? groundHeightAt(scene, e.at.x, e.at.z) : 0;
}

/** Box of one element across its whole animation (a moving element's box covers its path). Null for elements that never need framing (clouds). */
export function elementBox(scene: Pick<Scene3d, "world" | "elements">, e: Scene3dElement): Box | null {
  const s = e.at.scale;
  const { x, z } = e.at;
  const y = baseY(scene, e);
  const centred = (w: number, h: number, d: number, cx = x, cz = z, cy = y): Box => ({ min: [cx - w / 2, cy, cz - d / 2], max: [cx + w / 2, cy + h, cz + d / 2] });
  let b: Box | null;
  switch (e.kind) {
    case "model": { const f = (e.footprint_m ?? e.height_m * 0.6) * s; b = centred(f, e.height_m * s, f); break; }
    case "terrain": b = { min: [x - e.size_m[0] / 2, (e.at.y ?? 0), z - e.size_m[1] / 2], max: [x + e.size_m[0] / 2, (e.at.y ?? 0) + e.height_m, z + e.size_m[1] / 2] }; break;
    case "water": b = { min: [x - e.size_m[0] / 2, e.level_y - e.depth_m, z - e.size_m[1] / 2], max: [x + e.size_m[0] / 2, e.level_y, z + e.size_m[1] / 2] }; break;
    case "strata_cut": b = { min: [x, y - e.size_m[1], z - e.size_m[2] / 2], max: [x + e.size_m[0], y, z + e.size_m[2] / 2] }; break;
    case "rock_pile": { const r = e.shape === "ring" ? e.radius_m + e.width_m : e.radius_m; b = centred(2 * r * s, e.height_m * s, 2 * r * s); break; }
    case "sand_pile": b = centred(2 * e.radius_m * s, e.height_m * s, 2 * e.radius_m * s); break;
    case "crowd": b = centred(e.area_m[0] * s, e.person_height_m, e.area_m[1] * s); break;
    case "text_label": b = centred(e.text.length * e.height_m * 0.6 * s, e.height_m * s, e.height_m * 0.3 * s); break;
    case "arrow": b = { min: [Math.min(x, e.to[0]), Math.min(y, e.to[1]), Math.min(z, e.to[2])], max: [Math.max(x, e.to[0]), Math.max(y, e.to[1]), Math.max(z, e.to[2])] }; break;
    case "ruler": b = e.axis === "y" ? centred(e.length_m * 0.1, e.length_m, e.length_m * 0.1) : e.axis === "x" ? centred(e.length_m, e.length_m * 0.05, e.length_m * 0.05) : centred(e.length_m * 0.05, e.length_m * 0.05, e.length_m); break;
    case "box": b = centred(e.size_m[0] * s, e.size_m[1] * s, e.size_m[2] * s); break;
    case "cylinder": b = centred(2 * e.radius_m * s, e.height_m * s, 2 * e.radius_m * s); break;
    case "sphere": b = centred(2 * e.radius_m * s, 2 * e.radius_m * s, 2 * e.radius_m * s); break;
    case "ship": b = centred(e.length_m * s, e.length_m * 0.3 * s, e.length_m * 0.28 * s); break;
    case "skyline": b = centred(e.area_m[0], e.max_height_m, e.area_m[1]); break;
    case "clouds": return null;
  }
  for (const a of e.animations) {
    if (a.type !== "move_along_path") continue;
    const w = b.max[0] - b.min[0];
    const d = b.max[2] - b.min[2];
    for (const [px, pz] of a.path) b = unionBox(b, { min: [px - w / 2, b.min[1], pz - d / 2], max: [px + w / 2, b.max[1], pz + d / 2] });
  }
  return b;
}

/** Box around several elements by id (unknown ids and cloud-only lists give null). */
export function focusBox(scene: Pick<Scene3d, "world" | "elements">, ids: string | readonly string[]): Box | null {
  const list = typeof ids === "string" ? [ids] : ids;
  let out: Box | null = null;
  for (const id of list) {
    const e = scene.elements.find((el) => el.id === id);
    const b = e ? elementBox(scene, e) : null;
    if (b) out = out ? unionBox(out, b) : b;
  }
  return out;
}
