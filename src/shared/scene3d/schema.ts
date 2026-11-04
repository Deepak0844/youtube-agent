// Scene format v2: pure data a "director" writes and the Scene3D composition renders. No 3D code is ever written by an LLM:
// every element is a kind from a fixed block set. Units are metres, seconds, degrees. Pure zod, no app imports.
import { z } from "zod";

export const SCENE3D_FPS = 30;

export const SCENE3D_LIMITS = {
  maxTotalS: 60,
  minTotalS: 2,
  maxElements: 150,
  maxShots: 24,
  maxShotS: 20,
  minShotS: 0.8,
  maxAnimations: 6,
  maxPathPoints: 16,
  maxCrowd: 300,
  maxRocks: 4000,
  maxLayers: 14,
  maxText: 60,
  maxCaption: 60,
  coordM: 3000,
  maxSizeM: 4000,
} as const;
const L = SCENE3D_LIMITS;

export const SKY_PRESETS = ["clear", "haze", "dusk", "overcast"] as const;
export const GROUND_KINDS = ["sand", "grass", "rock", "none"] as const;
export const ELEMENT_KINDS = ["model", "terrain", "water", "strata_cut", "rock_pile", "sand_pile", "crowd", "text_label", "arrow", "ruler", "box", "cylinder", "sphere", "ship", "skyline", "clouds"] as const;
export const EASES = ["linear", "in", "out", "in_out", "back_out"] as const;
export type Ease = (typeof EASES)[number];

const num = (min: number, max: number) => z.number().min(min).max(max);
const coord = num(-L.coordM, L.coordM);
const size = num(0.01, L.maxSizeM);
const id = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, "must be lowercase letters, digits and underscores, starting with a letter");
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be a colour like #aa8844");
const xz = z.tuple([coord, coord]);
const xyz = z.tuple([coord, num(-500, 3000), coord]);
const t = num(0, L.maxTotalS);

export const placementSchema = z
  .object({
    x: coord.default(0),
    z: coord.default(0),
    /** Height in metres. Left out = stand on the ground at (x, z) when snap is on. */
    y: num(-500, 3000).optional(),
    rot_deg: num(-360, 360).default(0),
    scale: num(0.01, 100).default(1),
    snap: z.boolean().default(true),
  })
  .strict();

export const materialSchema = z
  .object({ color: hex.default("#cccccc"), roughness: num(0, 1).default(0.7), metalness: num(0, 1).default(0), opacity: num(0.05, 1).default(1) })
  .strict();

const timing = { start_s: t, duration_s: num(0.1, L.maxTotalS), ease: z.enum(EASES).default("in_out") };
export const animationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("move_along_path"), path: z.array(xz).min(2).max(L.maxPathPoints), face_direction: z.boolean().default(true), ...timing }).strict(),
  z.object({ type: z.literal("rotate"), degrees: num(-3600, 3600), ...timing }).strict(),
  z.object({ type: z.literal("grow"), from_scale: num(0, 1).default(0), ...timing }).strict(),
  z.object({ type: z.literal("build_up"), ...timing }).strict(),
  /** A stream of falling material that builds this element (a sand_pile) up from nothing. `from` is the nozzle in world metres. */
  z.object({ type: z.literal("pour"), from: xyz, ...timing }).strict(),
]);

const defaultAt = { x: 0, z: 0, rot_deg: 0, scale: 1, snap: true };
const base = { id, at: placementSchema.default(defaultAt), animations: z.array(animationSchema).max(L.maxAnimations).default([]) };
const defaultMat = { color: "#cccccc", roughness: 0.7, metalness: 0, opacity: 1 };
const modelRef = z.union([z.object({ catalog: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/) }).strict(), z.object({ file: z.string().min(3).max(200) }).strict()]);
const layer = z.object({ color: hex, thickness_m: num(0.05, 500), pebbles: z.boolean().default(false), grain: num(0, 1).default(0.4) }).strict();
const surface = z.enum(["sand", "grass", "rock", "snow", "asphalt"]);

export const elementSchema = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("model"), model: modelRef, height_m: size, footprint_m: size.optional(), tint: hex.optional() }).strict(),
  z.object({ ...base, kind: z.literal("terrain"), size_m: z.tuple([size, size]), height_m: num(0, 2000).default(1), top: surface.default("sand"), shape: z.enum(["flat", "hills", "island"]).default("flat") }).strict(),
  z.object({ ...base, kind: z.literal("water"), size_m: z.tuple([size, size]), depth_m: num(0.2, 500).default(8), level_y: num(-50, 500).default(0), shallow_color: hex.default("#46d9d5"), deep_color: hex.default("#0b5fa8") }).strict(),
  z.object({ ...base, kind: z.literal("strata_cut"), size_m: z.tuple([size, size, size]), layers: z.array(layer).min(1).max(L.maxLayers), tilt_deg: num(-45, 45).default(0), top: surface.default("sand"), ramp_m: num(0, 500).default(0) }).strict(),
  z.object({ ...base, kind: z.literal("rock_pile"), shape: z.enum(["pile", "ring"]).default("pile"), radius_m: size, width_m: num(0.5, 500).default(8), height_m: size, count: z.number().int().min(1).max(L.maxRocks).default(300), arc_deg: z.tuple([num(-360, 360), num(-360, 360)]).default([0, 360]), seed: z.number().int().min(0).max(9999).default(1) }).strict(),
  z.object({ ...base, kind: z.literal("sand_pile"), radius_m: size, height_m: size, color: hex.default("#e9d29c"), seed: z.number().int().min(0).max(9999).default(1) }).strict(),
  z.object({ ...base, kind: z.literal("crowd"), count: z.number().int().min(1).max(L.maxCrowd), area_m: z.tuple([size, size]), person_height_m: num(0.5, 3).default(1.75), seed: z.number().int().min(0).max(9999).default(1) }).strict(),
  z.object({ ...base, kind: z.literal("text_label"), text: z.string().min(1).max(L.maxText), height_m: num(0.1, 200).default(2), color: hex.default("#ffffff") }).strict(),
  z.object({ ...base, kind: z.literal("arrow"), to: xyz, color: hex.default("#ffd21f"), thickness_m: num(0.05, 20).default(0.4) }).strict(),
  z.object({ ...base, kind: z.literal("ruler"), length_m: num(0.5, 4000), ticks: z.number().int().min(1).max(40).default(5), axis: z.enum(["x", "y", "z"]).default("y"), color: hex.default("#ffffff") }).strict(),
  z.object({ ...base, kind: z.literal("box"), size_m: z.tuple([size, size, size]), material: materialSchema.default(defaultMat) }).strict(),
  z.object({ ...base, kind: z.literal("cylinder"), radius_m: size, height_m: size, material: materialSchema.default(defaultMat) }).strict(),
  z.object({ ...base, kind: z.literal("sphere"), radius_m: size, material: materialSchema.default(defaultMat) }).strict(),
  z.object({ ...base, kind: z.literal("ship"), length_m: num(2, 400), hull_color: hex.default("#d23a2b"), cargo: z.enum(["sand", "none"]).default("sand") }).strict(),
  z.object({ ...base, kind: z.literal("skyline"), area_m: z.tuple([size, size]), count: z.number().int().min(1).max(400).default(80), min_height_m: num(3, 800).default(20), max_height_m: num(3, 900).default(90), seed: z.number().int().min(0).max(9999).default(1) }).strict(),
  z.object({ ...base, kind: z.literal("clouds"), count: z.number().int().min(1).max(40).default(8), altitude_m: num(20, 3000).default(260), area_m: size.default(900), seed: z.number().int().min(0).max(9999).default(1) }).strict(),
]);

export const shotSchema = z
  .object({
    id,
    duration_s: num(L.minShotS, L.maxShotS),
    /** What the camera frames: one element id or several. Left out = free camera. */
    focus: z.union([id, z.array(id).min(1).max(12)]).optional(),
    /** Free camera: eye and look-at point in world metres. Used when focus is left out. */
    free: z.object({ position: xyz, target: xyz }).strict().optional(),
    yaw_deg: num(-180, 180).default(35),
    pitch_deg: num(2, 85).default(28),
    /** Multiplies the distance that exactly fits the focus in the safe area (below 1 = closer). */
    distance_mul: num(0.4, 4).default(1),
    /** How far (0..1) the camera pushes in over the shot. */
    push_in: num(0, 0.6).default(0.12),
    caption: z.string().min(1).max(L.maxCaption).optional(),
  })
  .strict();

const defaultWorld = { sky: "clear" as const, sun: { azimuth_deg: -40, elevation_deg: 48, intensity: 2.6 }, ground: { kind: "sand" as const, y: 0 } };
export const worldSchema = z
  .object({
    sky: z.enum(SKY_PRESETS).default("clear"),
    sun: z.object({ azimuth_deg: num(-360, 360).default(-40), elevation_deg: num(5, 90).default(48), intensity: num(0, 6).default(2.6) }).strict().default(defaultWorld.sun),
    fog: z.object({ near_m: num(0, 5000), far_m: num(10, 20000) }).strict().optional(),
    ground: z.object({ kind: z.enum(GROUND_KINDS).default("sand"), y: num(-50, 500).default(0) }).strict().default(defaultWorld.ground),
  })
  .strict();

export const scene3dSchema = z
  .object({
    version: z.literal(2),
    fps: z.literal(SCENE3D_FPS).default(SCENE3D_FPS),
    world: worldSchema.default(defaultWorld),
    elements: z.array(elementSchema).min(1).max(L.maxElements),
    shots: z.array(shotSchema).min(1).max(L.maxShots),
  })
  .strict();

export type Scene3d = z.infer<typeof scene3dSchema>;
export type Scene3dInput = z.input<typeof scene3dSchema>;
export type Scene3dElement = z.infer<typeof elementSchema>;
export type Scene3dShot = z.infer<typeof shotSchema>;
export type Scene3dAnimation = z.infer<typeof animationSchema>;
export type Scene3dMaterial = z.infer<typeof materialSchema>;
