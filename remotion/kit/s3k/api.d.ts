// Typed manifest of the s3k kit: THE SOURCE of API.md (npm run s3k:api). One `export` per name in index.ts, ONE short comment line above each,
// props written inline. A unit test fails when a name in index.ts is missing here, or when API.md is stale. Units: metres, seconds, degrees; y is up.
// Sections start with `// ## Title`; the generator keeps each section under ~6 KB.
import type { FC, ReactNode, Context } from "react";
import type * as THREE from "three";

type V3 = [number, number, number];
type Box = { min: V3; max: V3 };
type Slot = { x: number; y: number; z: number; rx?: number; ry?: number; rz?: number; s?: number };
type Layer = { color: string; h: number; pebbles?: boolean | { count?: number; rmin?: number; rmax?: number } };
type RigShot = { t: number; at: V3; look: V3 } | { t: number; frame: { box: Box; yawDeg: number; pitchDeg: number; distanceMul?: number } };
type Coverage = { fits: boolean; width: number; height: number; fill: number };
type Safe = { top: number; bottom: number; left: number; right: number };
type PresetName = "clear" | "haze" | "dusk" | "overcast" | "studio";
type WorldPreset = { top: string; mid: string; horizon: string; fog: string; fogDensity: number; sun: string; sunIntensity: number; sunAzimuthDeg: number; sunElevationDeg: number; glow: number; hemiSky: string; hemiGround: string; hemiK: number; bounce: string; exposure: number };
type ModelResolver = { resolve(ref: { catalog: string } | { file: string }): { url: string } | null };
type FitOptions = { size?: number; height?: boolean; info?: { default_scale?: number; pivot?: "bottom" | "center" }; matte?: boolean };
type Models = { has(id: string): boolean; get(id: string, o?: FitOptions): THREE.Group };
type Seed = { a: number; r: number; p: number; sp: number; v: number };
type Plane = number | { y: number } | ((x: number, z: number) => number);

// ## Scene skeleton
/** One story beat with its REAL time in the narration (seconds). */
export type SceneBeat = { id: string; text: string; from: number; to: number };
/** The props of the default-exported scene component of an AI-written scene. The host draws Stage, the captions and the sound: your scene returns only the 3D content (World ... Finish). */
export type SceneProps = { resolver: ModelResolver; beats: readonly SceneBeat[]; durationS: number };
/** THE PAGE: wraps your 3D content in the canvas (ACES, soft shadows) and gives useT(); `overlay` is HTML drawn over it (Captions). Children: World, objects, CameraRig, Finish LAST. */
export const Stage: FC<{ children: ReactNode; overlay?: ReactNode; background?: string }>;
/** Seconds since the start of the video. Call it once per component and pass t to every update(t); motion must be a pure function of t. */
export function useT(): number;
/** Same object while its JSON is unchanged: wrap inline object props so they do not rebuild the scene every frame. */
export function useStable<T>(value: T): T;
/** React context behind useT (Stage provides it; you never need it). */
export const TimeContext: Context<number>;

// ## World (sky, haze, sun, light, ground, sea)
/** Sky gradient, exp haze, sun with soft shadows fitted to `focus`, environment light baked once. ground/sea planes reach the horizon; z ranges clip them (zMax: 0 = only behind a cut at z = 0). */
export const World: FC<{ focus: Box; preset?: PresetName; tweak?: Partial<WorldPreset>; ground?: { y?: number; kind?: "pave" | "sand" | "plain"; tile?: number; color?: string; zMin?: number; zMax?: number } | false; sea?: { y: number; color?: string; zMin?: number; zMax?: number; foamZ?: number } | false; shadowSize?: 2048 | 4096 }>;
/** Preset values merged with tweak; throws a clear message when out of range (fogDensity 0..0.02, sunIntensity 0..10, sunElevationDeg 2..89, exposure 0.3..3). */
export function resolvePreset(name?: PresetName, tweak?: Partial<WorldPreset>): WorldPreset;
/** The four looks: haze (default, approved), clear, dusk, overcast. */
export const WORLD_PRESETS: Record<PresetName, WorldPreset>;
/** ["clear", "haze", "dusk", "overcast"]. */
export const PRESET_NAMES: readonly PresetName[];
/** Allowed ranges of the preset numbers. */
export const PRESET_LIMITS: Readonly<Record<string, readonly [number, number]>>;
/** Problems found in a preset (empty = valid). */
export function presetProblems(p: WorldPreset): string[];
/** Shadow camera that covers exactly box b for a sun towards dir; casterReach pulls near back so tall things outside still shadow. */
export function fitSunFrustum(b: Box, dir: V3, margin?: number, casterReach?: number): { target: V3; position: V3; left: number; right: number; top: number; bottom: number; near: number; far: number };
/** Unit vector towards the sun (azimuth 0 = +z, 90 = +x). */
export function sunVector(azimuthDeg: number, elevationDeg: number): V3;
/** THE RULE: put the lowest point of object on the plane (a height, {y} or fn(x,z)), plus lift (0.03 stops z-fighting). Never place by a guessed y. */
export function rest<T extends THREE.Object3D>(object: T, plane: Plane, lift?: number): T;
/** rest() on uneven ground given as a function of x, z. */
export function groundSnap<T extends THREE.Object3D>(object: T, ground: (x: number, z: number) => number, lift?: number): T;
/** Lowest world y of an object. */
export function lowestY(object: THREE.Object3D): number;
/** Height change that puts minY on planeY (+lift). */
export function restOffset(minY: number, planeY: number, lift?: number): number;
/** Names of items whose lowest point is more than tol (0.05) from their plane: a floating check. */
export function floaters(items: readonly { name: string; minY: number; planeY: number }[], tol?: number): string[];

// ## Cutaway ground
/** Cut face of earth at plane z (default 0, viewer on +z): layers (strata, tilt up to 25 deg), holes punched out, parapet, a sea strip in front, a glass-front water block behind. */
export const CutawayBox: FC<{ x0: number; x1: number; bottom: number; top?: number; holes?: [number, number][][]; layers?: readonly Layer[]; tiltDeg?: number; tile?: number; z?: number; parapet?: boolean | { height?: number; color?: string }; seaStrip?: { y: number; depth?: number; color?: string }; waterBlock?: { x0: number; x1: number; y0: number; y1: number; depth?: number } }>;
/** Face geometry (rectangle with holes, world-aligned UVs). */
export function buildCutFace(p: { x0: number; x1: number; top?: number; bottom: number; holes?: [number, number][][]; tile?: number; tiltDeg?: number }): THREE.ShapeGeometry;
/** World-aligned strata UV for a point: one tile = `tile` metres, tilt shears the layers. */
export function strataUV(x: number, y: number, tile: number, tiltDeg: number, top?: number): [number, number];
/** Maximum layer tilt in degrees (25). */
export const TILT_LIMIT_DEG: number;
/** Default soil layers, top to bottom (sand with dense pebbles, clay, gravel...). pebbles: true | { count, rmin, rmax }. */
export const STRATA_DEFAULT: readonly Layer[];
/** Lower edge of each layer as a 0..1 fraction of the tile (top 0). */
export function layerEdges(layers: readonly Layer[]): number[];

// ## Finish chain
/** LAST child of Stage: GTAO, depth of field that follows focus (a [x,y,z] point, a distance, or the rig target), bloom, vignette, tone map; MSAA half-float. mode "fast" = no AO/DOF. */
export const Finish: FC<{ focus?: V3 | number; mode?: "full" | "fast"; ao?: boolean; dof?: number; bloom?: number; vignette?: number; saturation?: number }>;
/** Clamps every Finish knob into its limit and applies mode. */
export function resolveFinish(p: { mode?: "full" | "fast"; ao?: boolean; dof?: number; bloom?: number; vignette?: number; saturation?: number }): { ao: boolean; dof: number; bloom: number; vignette: number; saturation: number; samples: number };
/** Defaults: bloom 0.32, vignette 0.42, saturation 1.08, dof 1. */
export const FINISH_DEFAULTS: Readonly<Record<string, number>>;
/** Limits: dof 0..3, bloom 0..1.5, vignette 0..0.8, saturation 0.5..1.5. */
export const FINISH_LIMITS: Readonly<Record<string, readonly [number, number]>>;

// ## Camera rig and captions
/** One glide through shot keys (monotone spline, rest at both ends). Shots: { t, at, look } or { t, frame: { box, yawDeg, pitchDeg } } fitted into the portrait safe area. floor keeps the eye above ground/water. hero leans look-at to a moving object. Needs 2+ shots, increasing t. */
export const CameraRig: FC<{ shots: readonly RigShot[]; floor?: number | ((x: number, z: number) => number); hero?: { at: (t: number) => V3; from: number; to: number; strength?: number; fade?: number }; safe?: Safe; fov?: number; onReport?: (r: { index: number; fill: number; fits: boolean }[]) => void }>;
/** Wrap the ONE hero (the thing the story is about) in <Hero>...</Hero>; it changes nothing on screen. The app measures it in the preview pictures: it must be declared, 25 to 60 percent of the frame width, and never cut off by the frame. */
export const Hero: FC<{ children: ReactNode }>;
/** Nearest camera along yaw/pitch that fits the box in the safe area, never below minY; returns position, target, coverage, pitch. */
export function frameFocus(i: { box: Box; yawDeg: number; pitchDeg: number; aspect: number; safe?: Safe; fovDeg?: number; minY?: number; distanceMul?: number }): { position: V3; target: V3; coverage: Coverage; pitchDeg: number };
/** How much of the safe area a box covers from a camera: fits, width, height, fill (aim 0.7..1 hero, 0.3..0.6 establishing). */
export function coverage(box: Box, eye: V3, target: V3, aspect: number, safe?: Safe, fovDeg?: number): Coverage;
/** n key times over duration that give the proof's gentle start and end. */
export function glideTimes(n: number, duration: number): number[];
/** Shots -> spline keys for an aspect ratio. */
export function resolveShots(shots: readonly RigShot[], aspect: number, opt?: { safe?: Safe; minY?: number; fovDeg?: number }): { key: { t: number; position: V3; target: V3 }; coverage: Coverage | null }[];
/** Camera pose at t from keys, above floor, hero lock applied. */
export function rigPose(keys: readonly { t: number; position: V3; target: V3 }[], t: number, floor?: number | ((x: number, z: number) => number), hero?: { at: (t: number) => V3; from: number; to: number; strength?: number; fade?: number }): { position: V3; target: V3 };
/** Hero lock weight 0..1 at t (eases in and out). */
export function heroWeight(t: number, h: { from: number; to: number; strength?: number; fade?: number }): number;
/** Vertical field of view used everywhere (40). */
export const FOV_DEG: number;
/** Safe area for 9:16: top 0.24 (caption), bottom 0.10, sides 0.06. */
export const SAFE_PORTRAIT: Safe;
/** Safe area for 16:9. */
export const SAFE_WIDE: Safe;
/** Safe area for an aspect ratio. */
export function safeFor(aspect: number): Safe;
/** Caption pill (white bold on dark rounded) for the current time; sibling AFTER the canvas via Stage overlay. Keep texts under ~32 characters. */
export const Captions: FC<{ items: readonly { from: number; to: number; text: string }[]; top?: number; size?: number }>;
/** Opacity k/alpha of a caption at t (ease in 0.35 s, out 0.3 s). */
export function captionPhase(t: number, from: number, to: number): { active: boolean; k: number; alpha: number };
/** 3D measuring line with end ticks and a label that faces the camera. */
export const Ruler: FC<{ from: V3; to: V3; label: string; color?: string; width?: number; labelSize?: number }>;
/** A text tag in the scene (white on a dark pill, faces the camera, drawn on top), size = height in metres: name the parts (head, next, null). */
export function label(text: string, o?: { size?: number; color?: string; background?: string }): THREE.Sprite;

// ## Models, instancing, particles
/** Loads catalogue ids through resolver, holds the render until drawn once. Returns null while loading: render nothing until it is set. Missing models become grey boxes. */
export function useModels(ids: readonly string[], resolver: ModelResolver, info?: (id: string) => { default_scale?: number; pivot?: "bottom" | "center" } | undefined): Models | null;
/** models.get(id, { size, height }) = clone with base on y 0, centred on x/z, longest side (or height) = size metres; no size = manifest default_scale. */
export function fitModel(source: THREE.Object3D, o?: FitOptions): THREE.Group;
/** Scale that makes dims meet the FitOptions. */
export function fitScale(dims: { x: number; y: number; z: number }, o: FitOptions): number;
/** Resolver from a function id -> url (in a render: staticFile("assets3d/files/<id>.glb")). */
export function idResolver(urlFor: (id: string) => string): ModelResolver;
/** Hold the render yourself for your own async set-up; call the returned function once when done. */
export function useHold(label: string): () => void;
/** InstancedMesh with one copy per slot (one draw call); tint(i) gives a colour per copy. */
export function instance(geo: THREE.BufferGeometry, mat: THREE.Material, slots: readonly Slot[], o?: { tint?: (i: number) => THREE.ColorRepresentation; shadows?: boolean }): THREE.InstancedMesh;
/** Rewrites an InstancedMesh's matrices from slots (move them in update). */
export function placeSlots(im: THREE.InstancedMesh, slots: readonly Slot[]): void;
/** count slots in a straight row: start + step * i. */
export function rowSlots(count: number, start: V3, step: V3): Slot[];
/** count slots on a circle in the plane perpendicular to axis x|y|z, each rotated outward. */
export function ringSlots(count: number, radius: number, axis?: "x" | "y" | "z", c?: V3, startDeg?: number): Slot[];
/** cols x rows grid on a wall facing z or x (windows, panels), cells dx by dy apart, centred on c. */
export function gridSlots(cols: number, rows: number, dx: number, dy: number, c?: V3, axis?: "z" | "x"): Slot[];
/** CPU-updated Points for dust, spray, smoke: emit(seed, phase 0..1, t, out, i) writes each position; call update(t) every frame, add points to the scene. */
export function makeParticles(o: { count: number; seed?: number; size?: number; color?: string; opacity?: number; emit: (s: Seed, ph: number, t: number, out: V3, i: number) => void }): { points: THREE.Points; update: (t: number) => void };
/** Per-particle fixed random numbers a, r, p, sp, v (0..1, sp 0.12..0.42). */
export function particleSeeds(count: number, seed?: number): Seed[];
/** Looping phase 0..1 of a particle at t. */
export function phaseOf(t: number, s: { p: number; sp: number }): number;

// ## Parts, textures, city, maths
/** Standard material (rough .55, metal .1, env .5). */
export function std(color: string | number, o?: Partial<THREE.MeshStandardMaterialParameters>): THREE.MeshStandardMaterial;
/** Painted steel material. */
export function steel(c: string | number, rough?: number): THREE.MeshStandardMaterial;
/** Emissive lamp material (bloom picks it up). */
export function glow(c: string, k?: number): THREE.MeshStandardMaterial;
/** Env light factor baked into std (0.5). */
export const ENV_K: number;
/** Cast/receive shadows on a whole tree. */
export function shadowize<T extends THREE.Object3D>(o: T, cast?: boolean, recv?: boolean): T;
/** Box w,h,d centred at x,y,z; added to parent when given. */
export function box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, parent?: THREE.Object3D): THREE.Mesh;
/** Cylinder along axis x|y|z centred at x,y,z. */
export function cyl(rt: number, rb: number, len: number, mat: THREE.Material, axis: "x" | "y" | "z", x: number, y: number, z: number, parent?: THREE.Object3D, seg?: number): THREE.Mesh;
/** Strut of radius r from a to b. */
export function between(a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material, parent?: THREE.Object3D, seg?: number): THREE.Mesh;
/** Arrow from a to b (shaft of radius r, cone head ending at b): use it for any direction, flow or "points to" link. */
export function arrow(a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material, parent?: THREE.Object3D): THREE.Group;
/** Wedge of a ring around the x axis (half pipe, tunnel wall): outer/inner radius, angles in radians, length along +x. */
export function sector(rO: number, rI: number, a0: number, a1: number, len: number): THREE.ExtrudeGeometry;
/** Full ring around the x axis. */
export function ring(rO: number, rI: number, len: number): THREE.ExtrudeGeometry;
/** Seeded random 0..1 generator: the only allowed randomness (frames must repeat). */
export function rnd(seed: number): () => number;
/** Clamp x into lo..hi (default 0..1). */
export function clamp(x: number, lo?: number, hi?: number): number;
/** Linear blend a to b by u. */
export function lerp(a: number, b: number, u: number): number;
/** Smootherstep of x clamped 0..1. */
export function smooth(x: number): number;
/** Progress of t through [a, b] clamped 0..1: ramp(t, 4, 6). */
export function ramp(t: number, a: number, b: number): number;
/** Canvas -> sRGB texture (rep = RepeatWrapping repeats). Textures are cached; clone before changing repeat. */
export function toTexture(c: HTMLCanvasElement, rep?: [number, number]): THREE.CanvasTexture;
/** Layered ground tile (tiles seamlessly across x). */
export function strataTexture(layers?: readonly Layer[], seed?: number): THREE.CanvasTexture;
/** River stones tile. */
export function pebbleTexture(rep?: [number, number]): THREE.CanvasTexture;
/** Sand with ripples. */
export function sandTexture(base?: string): THREE.CanvasTexture;
/** Water bump map. */
export function rippleTexture(): THREE.CanvasTexture;
/** Paving slabs. */
export function paveTexture(base?: string): THREE.CanvasTexture;
/** Road asphalt with lane lines (tile 16 m x 7.5 m). */
export function asphaltTexture(): THREE.CanvasTexture;
/** Poured concrete with joints; band = coloured stripe. */
export function concreteTexture(base?: string, band?: string): THREE.CanvasTexture;
/** Conveyor cleats; scroll with offset.x. */
export function beltTexture(): THREE.CanvasTexture;
/** Sign text on a flat colour (use MeshBasicMaterial toneMapped:false). */
export function signTexture(text: string, bg?: string, fg?: string): THREE.CanvasTexture;
/** Soft round dot for particles. */
export function dustSprite(): THREE.CanvasTexture;
/** Water-behind-glass colour ramp. */
export function glassWaterTexture(): THREE.CanvasTexture;
/** Glass facade tile, kind 0..4. */
export function facadeTexture(kind: number): THREE.CanvasTexture;
/** Box whose UVs are in metres: windows keep their size on any tower. */
export function tower(w: number, h: number, d: number): THREE.BoxGeometry;
/** Five facade materials (far = flat). */
export function towerMaterials(far?: boolean): THREE.MeshStandardMaterial[];
/** Tower with crown and spire/dome, base on y 0 at (x, z); scale.y to grow it. */
export function glassTower(mats: THREE.MeshStandardMaterial[], w: number, h: number, d: number, k: number, x: number, z: number): THREE.Group;
/** Ring of cheap far towers (no shadows) on the horizon. */
export function farSkyline(o?: { seed?: number; count?: number; x?: number; width?: number; zNear?: number; zFar?: number; groundY?: number }): THREE.Group;
