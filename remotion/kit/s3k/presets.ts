// World presets (sky, haze, sun, ground colours) and the pure maths for the sun's shadow frustum and for resting things on a plane.
// No three.js here: the unit tests load this file directly.

export type V3 = [number, number, number];
export type BoxV = { min: V3; max: V3 };

export type WorldPreset = {
  /** Sky colours from the zenith down to the horizon (the proof's three-stop gradient). */
  top: string; mid: string; horizon: string;
  /** Haze colour (also the page background) and its density: visibility ~ 1 / density metres. 0.0034 = misty at 300 m. */
  fog: string; fogDensity: number;
  sun: string; sunIntensity: number; sunAzimuthDeg: number; sunElevationDeg: number;
  /** Sun disc glow in the sky dome, 0 = none. */
  glow: number;
  hemiSky: string; hemiGround: string; hemiK: number;
  /** Colour the ground bounce adds to the baked environment light. */
  bounce: string;
  /** Tone-mapping exposure for the finish chain. */
  exposure: number;
};

export const PRESET_NAMES = ["clear", "haze", "dusk", "overcast"] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

export const WORLD_PRESETS: Record<PresetName, WorldPreset> = {
  // haze is the approved proof look: pale milky blue, sun from the front-left
  haze: { top: "#a9cfe8", mid: "#d3e6f0", horizon: "#eaf0f1", fog: "#d6e6ee", fogDensity: 0.0034, sun: "#fff0d6", sunIntensity: 3.3, sunAzimuthDeg: -41.6, sunElevationDeg: 43.3, glow: 0, hemiSky: "#cfe6ff", hemiGround: "#f1e0bb", hemiK: 0.4, bounce: "#e8dcc2", exposure: 1.05 },
  clear: { top: "#5ea7e6", mid: "#a9d3f2", horizon: "#e3f0f7", fog: "#dcebf3", fogDensity: 0.0024, sun: "#fff1dc", sunIntensity: 3.6, sunAzimuthDeg: -38, sunElevationDeg: 48, glow: 0.45, hemiSky: "#dff0ff", hemiGround: "#f0dcb8", hemiK: 0.35, bounce: "#e8dcc2", exposure: 1.0 },
  dusk: { top: "#35417f", mid: "#d98a8c", horizon: "#f8b98a", fog: "#e9b08e", fogDensity: 0.0036, sun: "#ffb27a", sunIntensity: 2.8, sunAzimuthDeg: -60, sunElevationDeg: 12, glow: 1, hemiSky: "#8f8fd0", hemiGround: "#c98a6a", hemiK: 0.5, bounce: "#c98a6a", exposure: 1.1 },
  overcast: { top: "#8e99a3", mid: "#bcc5cb", horizon: "#d9dee1", fog: "#d3d9dc", fogDensity: 0.0042, sun: "#f4f4f2", sunIntensity: 1.3, sunAzimuthDeg: -30, sunElevationDeg: 55, glow: 0, hemiSky: "#dfe6ea", hemiGround: "#b8b4aa", hemiK: 0.8, bounce: "#b8b4aa", exposure: 1.05 },
};

const HEX = /^#[0-9a-fA-F]{6}$/;
/** Returns what is wrong with a preset (empty list = fine). Used by the tests and by World before it builds anything. */
export function presetProblems(p: WorldPreset): string[] {
  const out: string[] = [];
  for (const k of ["top", "mid", "horizon", "fog", "sun", "hemiSky", "hemiGround", "bounce"] as const) if (!HEX.test(p[k])) out.push(`${k} is not a #rrggbb colour`);
  if (!(p.fogDensity >= 0 && p.fogDensity <= 0.02)) out.push("fogDensity must be 0..0.02");
  if (!(p.sunIntensity >= 0 && p.sunIntensity <= 10)) out.push("sunIntensity must be 0..10");
  if (!(p.sunElevationDeg > 2 && p.sunElevationDeg < 89)) out.push("sunElevationDeg must be 2..89 (below the horizon casts no shadow)");
  if (!(p.exposure > 0.3 && p.exposure < 3)) out.push("exposure must be 0.3..3");
  return out;
}

/** The preset with the author's tweaks applied; throws with a clear message when a value is out of range. */
export function resolvePreset(name: PresetName = "haze", tweak?: Partial<WorldPreset>): WorldPreset {
  const p = { ...WORLD_PRESETS[name], ...tweak };
  const bad = presetProblems(p);
  if (bad.length) throw new Error(`World preset "${name}": ${bad.join("; ")}`);
  return p;
}

export const PRESET_LIMITS = { fogDensity: [0, 0.02], sunIntensity: [0, 10], sunElevationDeg: [2, 89], exposure: [0.3, 3] } as const;

/** Unit vector from the ground towards the sun. Azimuth 0 = +z, 90 = +x. */
export const sunVector = (azimuthDeg: number, elevationDeg: number): V3 => {
  const a = (azimuthDeg * Math.PI) / 180;
  const e = (elevationDeg * Math.PI) / 180;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)];
};

export type SunFrustum = { target: V3; position: V3; left: number; right: number; top: number; bottom: number; near: number; far: number };
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/**
 * Orthographic shadow camera for a sun in direction `dir` (towards the sun) that covers exactly the box the shot looks at, so the shadow map's
 * pixels are spent where they are seen. `casterReach` pulls the near plane back so tall things outside the box still throw shadows into it.
 * Every corner of the box lies inside left..right, bottom..top and near..far. Pure.
 */
export function fitSunFrustum(b: BoxV, dir: V3, margin = 1.08, casterReach = 60): SunFrustum {
  const d = unit(dir);
  const fwd: V3 = [-d[0], -d[1], -d[2]];
  const right = unit(Math.abs(d[1]) > 0.99 ? [1, 0, 0] : cross(fwd, [0, 1, 0]));
  const up = cross(right, fwd);
  const c: V3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  let rMin = Infinity, rMax = -Infinity, uMin = Infinity, uMax = -Infinity, fMin = Infinity, fMax = -Infinity;
  for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) {
    const p = sub([x, y, z], c);
    rMin = Math.min(rMin, dot(p, right)); rMax = Math.max(rMax, dot(p, right));
    uMin = Math.min(uMin, dot(p, up)); uMax = Math.max(uMax, dot(p, up));
    fMin = Math.min(fMin, dot(p, fwd)); fMax = Math.max(fMax, dot(p, fwd));
  }
  const dist = Math.max(10, -fMin + casterReach + 5); // the camera sits this far from the centre, towards the sun
  const position: V3 = [c[0] + d[0] * dist, c[1] + d[1] * dist, c[2] + d[2] * dist];
  return {
    target: c, position,
    left: rMin * margin, right: rMax * margin, bottom: uMin * margin, top: uMax * margin,
    near: Math.max(0.5, dist + fMin - casterReach), far: dist + fMax + 2,
  };
}

/** Height offset that puts the lowest point of an object (minY, in world space) exactly on a plane at planeY (plus an optional lift). Pure. */
export const restOffset = (minY: number, planeY: number, lift = 0): number => planeY + lift - minY;

/** Names of objects whose lowest point is more than `tol` metres above or below their plane: the "nothing floats" check for tests and dev. Pure. */
export function floaters(items: readonly { name: string; minY: number; planeY: number }[], tol = 0.05): string[] {
  return items.filter((i) => Math.abs(i.minY - i.planeY) > tol).map((i) => i.name);
}
