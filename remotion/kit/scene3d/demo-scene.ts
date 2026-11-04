import type { Scene3dInput } from "../../../src/shared/scene3d/schema";

const SAND_LAYERS = [
  { color: "#ecd9ae", thickness_m: 1.0, grain: 0.5 },
  { color: "#d9bd88", thickness_m: 0.7, pebbles: true },
  { color: "#a8693f", thickness_m: 1.3 },
  { color: "#d6c7b0", thickness_m: 1.6 },
  { color: "#8e6446", thickness_m: 1.0, pebbles: true },
  { color: "#e3d6c0", thickness_m: 1.6 },
  { color: "#a9805f", thickness_m: 1.1 },
  { color: "#d8ccb8", thickness_m: 1.7 },
  { color: "#7d5c46", thickness_m: 1.0, pebbles: true },
  { color: "#cdbda5", thickness_m: 1.6 },
];

/** Dubai land reclamation as scene format v2 (metres). A ring wall of rock, a barge pouring sand into it, the ground cut open to show its layers. */
export const SCENE3D_DEMO: Scene3dInput = {
  version: 2,
  world: { sky: "haze", sun: { azimuth_deg: -40, elevation_deg: 46, intensity: 2.6 }, ground: { kind: "none", y: 0 }, fog: { near_m: 90, far_m: 520 } },
  elements: [
    { kind: "terrain", id: "plain", size_m: [2600, 700], height_m: 0.4, top: "sand", shape: "flat", at: { x: 0, z: -450 } },
    { kind: "water", id: "sea", size_m: [760, 120], depth_m: 8, level_y: 0, at: { x: 0, z: -36 } },
    { kind: "strata_cut", id: "land", size_m: [100, 13, 32.5], layers: SAND_LAYERS, tilt_deg: 9, top: "sand", ramp_m: 14, at: { x: -90, z: 8.25, y: 1 } },
    { kind: "strata_cut", id: "bedrock", size_m: [90, 8, 32.5], layers: SAND_LAYERS.map((l) => ({ ...l, color: "#b3a089" })), tilt_deg: 9, top: "sand", at: { x: 10, z: 8.25, y: -8 } },
    { kind: "rock_pile", id: "ring", shape: "ring", radius_m: 36, width_m: 8, height_m: 12, count: 1400, arc_deg: [-31, 200], at: { x: 6, z: -44, y: -8 } },
    { kind: "sand_pile", id: "mound", radius_m: 15, height_m: 12.7, at: { x: -30, z: -17, y: -8 }, animations: [{ type: "pour", from: [-21.6, 6.2, -15], start_s: 0.2, duration_s: 9.6, ease: "linear" }] },
    { kind: "ship", id: "barge", length_m: 26, hull_color: "#d23a2b", cargo: "sand", at: { x: -10, z: -15, y: 0.2, rot_deg: 0 }, animations: [{ type: "move_along_path", path: [[-9, -15], [-12, -15.5]], face_direction: true, start_s: 0, duration_s: 10, ease: "linear" }] },
    { kind: "model", id: "house", model: { file: "models/house.glb" }, height_m: 10, footprint_m: 9, at: { x: -33, z: 6, rot_deg: 20 } },
    { kind: "crowd", id: "workers", count: 9, area_m: [14, 10], person_height_m: 1.8, at: { x: -50, z: 12 } },
    { kind: "rock_pile", id: "scatter", shape: "pile", radius_m: 9, width_m: 6, height_m: 1.4, count: 60, at: { x: -62, z: 10 } },
    { kind: "sand_pile", id: "heap_a", radius_m: 3.2, height_m: 1.6, at: { x: -50, z: -2 } },
    { kind: "sand_pile", id: "heap_b", radius_m: 2.4, height_m: 1.2, at: { x: -43, z: 20, y: 1 } },
    { kind: "skyline", id: "city", area_m: [340, 150], count: 110, min_height_m: 22, max_height_m: 105, at: { x: 0, z: -235 } },
    { kind: "clouds", id: "sky_puffs", count: 6, altitude_m: 220, area_m: 700 },
  ],
  shots: [
    { id: "pour", duration_s: 3, focus: ["barge", "mound", "house"], yaw_deg: 30, pitch_deg: 24, distance_mul: 0.9, push_in: 0.18, caption: "fill." },
    { id: "ring", duration_s: 2.5, focus: ["ring", "barge"], yaw_deg: 18, pitch_deg: 38, distance_mul: 0.95, caption: "then we build." },
    { id: "layers", duration_s: 2.5, focus: ["land", "bedrock"], yaw_deg: 24, pitch_deg: 22, distance_mul: 0.8, caption: "layer by layer." },
    { id: "city", duration_s: 2, focus: "city", yaw_deg: 8, pitch_deg: 14, distance_mul: 0.85, push_in: 0.1, caption: "a city on top." },
  ],
};
