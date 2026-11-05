// One exact JSON example per scene element kind, animation kind and shot style, shown to the director. tests/unit/scene3d-direct.test.ts
// checks that every example passes the real validator and that every key the validator accepts is in the prompt, so they cannot drift.
// The model id "candidate_id" is a placeholder the director replaces with an id from the candidate list.
const MAT = { color: "#aa8844", roughness: 0.7, metalness: 0, opacity: 1 };
const AT = { x: 0, z: 0, y: 0, rot_deg: 0, scale: 1, snap: true };

export const ELEMENT_EXAMPLES: Record<string, Record<string, unknown>> = {
  model: { kind: "model", id: "barge", model: { catalog: "candidate_id" }, height_m: 20, footprint_m: 30, tint: "#aa8844", at: AT },
  terrain: { kind: "terrain", id: "plain", size_m: [400, 300], height_m: 1, top: "sand", shape: "flat" },
  water: { kind: "water", id: "sea", size_m: [400, 200], depth_m: 8, level_y: 0, shallow_color: "#46d9d5", deep_color: "#0b5fa8" },
  strata_cut: { kind: "strata_cut", id: "land", size_m: [100, 30, 32], layers: [{ color: "#ecd9ae", thickness_m: 1, pebbles: false, grain: 0.4 }], tilt_deg: 0, top: "sand", ramp_m: 0 },
  rock_pile: { kind: "rock_pile", id: "wall", shape: "ring", radius_m: 36, width_m: 8, height_m: 12, count: 300, arc_deg: [0, 360], seed: 1 },
  sand_pile: { kind: "sand_pile", id: "mound", radius_m: 15, height_m: 5, color: "#e9d29c", seed: 1 },
  crowd: { kind: "crowd", id: "workers", count: 20, area_m: [14, 10], person_height_m: 1.75, seed: 1 },
  text_label: { kind: "text_label", id: "label", text: "Day 1", height_m: 2, color: "#ffffff" },
  arrow: { kind: "arrow", id: "pointer", to: [10, 5, 0], color: "#ffd21f", thickness_m: 0.4 },
  ruler: { kind: "ruler", id: "scale", length_m: 100, ticks: 5, axis: "y", color: "#ffffff" },
  box: { kind: "box", id: "block", size_m: [4, 2, 2], material: MAT },
  cylinder: { kind: "cylinder", id: "pipe", radius_m: 2, height_m: 10, material: MAT },
  sphere: { kind: "sphere", id: "ball", radius_m: 2, material: MAT },
  ship: { kind: "ship", id: "dredger", length_m: 26, hull_color: "#d23a2b", cargo: "sand" },
  skyline: { kind: "skyline", id: "city", area_m: [340, 150], count: 80, min_height_m: 20, max_height_m: 90, seed: 1 },
  clouds: { kind: "clouds", id: "sky_puffs", count: 8, altitude_m: 260, area_m: 900, seed: 1 },
};

const TIME = { start_s: 0, duration_s: 5, ease: "in_out" };
export const ANIMATION_EXAMPLES: Record<string, Record<string, unknown>> = {
  move_along_path: { type: "move_along_path", path: [[0, 0], [10, 0], [10, 10]], face_direction: true, ...TIME },
  rotate: { type: "rotate", degrees: 90, ...TIME },
  grow: { type: "grow", from_scale: 0, ...TIME },
  build_up: { type: "build_up", ...TIME },
  pour: { type: "pour", from: [0, 10, 0], ...TIME },
};

export const SHOT_EXAMPLES: Record<string, unknown>[] = [
  { id: "hook", duration_s: 6, focus: ["barge", "sea"], yaw_deg: 35, pitch_deg: 28, distance_mul: 1, push_in: 0.12, caption: "Land from the sea" },
  { id: "setup", duration_s: 5, free: { position: [-12, 9, 100], target: [-12, 3, -14] } },
];

export const WORLD_EXAMPLE = { sky: "haze", sun: { azimuth_deg: -40, elevation_deg: 48, intensity: 2.6 }, ground: { kind: "sand", y: 0 }, fog: { near_m: 160, far_m: 1100 } };

export const MISSING_ASSET_LIMITS = { maxItems: 24, maxText: 80 } as const;
