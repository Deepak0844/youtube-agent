// Fills in the schema's default values without zod (the render container has none). tests/unit/scene3d-math.test.ts checks this
// gives exactly what scene3dSchema.parse gives, so the two cannot drift apart unnoticed.
import type { Scene3d, Scene3dInput } from "../../../src/shared/scene3d/schema";

type Obj = Record<string, unknown>;
const MAT = { color: "#cccccc", roughness: 0.7, metalness: 0, opacity: 1 };
const KIND_DEFAULTS: Record<string, Obj> = {
  model: {},
  terrain: { height_m: 1, top: "sand", shape: "flat" },
  water: { depth_m: 8, level_y: 0, shallow_color: "#46d9d5", deep_color: "#0b5fa8" },
  strata_cut: { tilt_deg: 0, top: "sand", ramp_m: 0 },
  rock_pile: { shape: "pile", width_m: 8, count: 300, arc_deg: [0, 360], seed: 1 },
  sand_pile: { color: "#e9d29c", seed: 1 },
  crowd: { person_height_m: 1.75, seed: 1 },
  text_label: { height_m: 2, color: "#ffffff" },
  arrow: { color: "#ffd21f", thickness_m: 0.4 },
  ruler: { ticks: 5, axis: "y", color: "#ffffff" },
  box: {},
  cylinder: {},
  sphere: {},
  ship: { hull_color: "#d23a2b", cargo: "sand" },
  skyline: { count: 80, min_height_m: 20, max_height_m: 90, seed: 1 },
  clouds: { count: 8, altitude_m: 260, area_m: 900, seed: 1 },
};
const ANIM_DEFAULTS: Record<string, Obj> = { move_along_path: { face_direction: true, ease: "in_out" }, rotate: { ease: "in_out" }, grow: { from_scale: 0, ease: "in_out" }, build_up: { ease: "in_out" }, pour: { ease: "in_out" } };

const fill = (d: Obj, v: Obj): Obj => ({ ...d, ...v });

export function withDefaults(input: Scene3dInput): Scene3d {
  const w = (input.world ?? {}) as Obj;
  const world = {
    sky: "clear",
    ...w,
    sun: fill({ azimuth_deg: -40, elevation_deg: 48, intensity: 2.6 }, (w.sun ?? {}) as Obj),
    ground: fill({ kind: "sand", y: 0 }, (w.ground ?? {}) as Obj),
  };
  const elements = input.elements.map((e) => {
    const v = e as unknown as Obj;
    const out = fill(KIND_DEFAULTS[e.kind] ?? {}, v);
    out.at = fill({ x: 0, z: 0, rot_deg: 0, scale: 1, snap: true }, (v.at ?? {}) as Obj);
    out.animations = ((v.animations ?? []) as Obj[]).map((a) => fill(ANIM_DEFAULTS[a.type as string] ?? {}, a));
    if (e.kind === "box" || e.kind === "cylinder" || e.kind === "sphere") out.material = fill(MAT, (v.material ?? {}) as Obj);
    if (e.kind === "strata_cut") out.layers = (v.layers as Obj[]).map((l) => fill({ pebbles: false, grain: 0.4 }, l));
    return out;
  });
  const shots = input.shots.map((s) => fill({ yaw_deg: 35, pitch_deg: 28, distance_mul: 1, push_in: 0.12 }, s as unknown as Obj));
  return { version: 2, fps: 30, world, elements, shots } as unknown as Scene3d;
}
