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
  world: { sky: "haze", sun: { azimuth_deg: -40, elevation_deg: 46, intensity: 2.6 }, ground: { kind: "none", y: 0 }, fog: { near_m: 160, far_m: 1100 } },
  elements: [
    { kind: "terrain", id: "plain", size_m: [12000, 6000], height_m: 0.4, top: "sand", shape: "flat", at: { x: 0, z: -3100 } },
    { kind: "water", id: "sea", size_m: [760, 120], depth_m: 8, level_y: 0, shallow_color: "#5adcd6", deep_color: "#1c9fc2", at: { x: 0, z: -36 } },
    { kind: "strata_cut", id: "land", size_m: [100, 30, 32.5], layers: SAND_LAYERS, tilt_deg: 9, top: "sand", ramp_m: 14, at: { x: -90, z: 8.25, y: 1 } },
    { kind: "strata_cut", id: "bedrock", size_m: [90, 24, 32.5], layers: SAND_LAYERS.map((l) => ({ ...l, color: "#b3a089" })), tilt_deg: 9, top: "sand", at: { x: 10, z: 8.25, y: -8 } },
    { kind: "rock_pile", id: "ring", shape: "ring", radius_m: 36, width_m: 8, height_m: 12, count: 1400, arc_deg: [-31, 200], at: { x: 6, z: -44, y: -8 } },
    { kind: "sand_pile", id: "mound", radius_m: 15, height_m: 5.5, at: { x: -30, z: -17, y: -1 }, animations: [{ type: "pour", from: [-21.6, 6.2, -15], start_s: 0.2, duration_s: 9.6, ease: "linear" }] },
    { kind: "ship", id: "barge", length_m: 26, hull_color: "#d23a2b", cargo: "sand", at: { x: -10, z: -15, y: 0.2, rot_deg: 0 }, animations: [{ type: "move_along_path", path: [[-9, -15], [-12, -15.5]], face_direction: true, start_s: 0, duration_s: 10, ease: "linear" }] },
    { kind: "model", id: "house", model: { file: "models/house.glb" }, height_m: 10, footprint_m: 9, at: { x: -33, z: 6, rot_deg: 20 } },
    { kind: "crowd", id: "workers", count: 9, area_m: [14, 10], person_height_m: 1.8, at: { x: -50, z: 12 } },
    { kind: "rock_pile", id: "scatter", shape: "pile", radius_m: 9, width_m: 6, height_m: 1.4, count: 60, at: { x: -62, z: 10 } },
    { kind: "sand_pile", id: "heap_a", radius_m: 3.2, height_m: 1.6, at: { x: -50, z: -2 } },
    { kind: "sand_pile", id: "heap_b", radius_m: 2.4, height_m: 1.2, at: { x: -43, z: 20, y: 1 } },
    { kind: "skyline", id: "city", area_m: [340, 150], count: 110, min_height_m: 22, max_height_m: 105, at: { x: 0, z: -235 } },
    { kind: "clouds", id: "sky_puffs", count: 6, altitude_m: 190, area_m: 600, at: { z: -120 } },
  ],
  shots: [
    { id: "pour", duration_s: 3, free: { position: [-12, 9, 100], target: [-12, 3, -14] }, push_in: 0.2, caption: "fill." },
    { id: "ring", duration_s: 2.5, focus: ["ring", "barge"], yaw_deg: 18, pitch_deg: 38, distance_mul: 0.95, caption: "then we build." },
    { id: "layers", duration_s: 2.5, free: { position: [-58, 4, 40], target: [-22, -3, 14] }, caption: "layer by layer." },
    { id: "city", duration_s: 2, free: { position: [-10, 11, 34], target: [0, 36, -200] }, push_in: 0.1, caption: "a city on top." },
  ],
};
