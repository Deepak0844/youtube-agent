// Pure maths for the 3D scale-comparison video: layout, camera path, ruler value, labels, beat timing.
// No imports: the render container loads this file too. Types are structural so it needs nothing from the schema.

export type MObject = { id: string; kind: string; height_m: number; carries?: string };
export type MBeat = { focus: string; range_m?: [number, number]; duration_s: number };
export type MScene = { objects: MObject[]; beats: MBeat[]; ruler?: { max_m?: number }; loop_back?: boolean };

/** Vertical field of view (degrees) and the sideways look angle of the camera. The span maths below assume these. */
export const FOV_DEG = 50;
export const YAW_RAD = 0.32;
/** Frame is portrait 9:16: the sideways view is this fraction of the vertical one. */
const ASPECT = 9 / 16;
const TAN_HALF_FOV = Math.tan((FOV_DEG * Math.PI) / 360);

/** Width of each model as a fraction of its height (the models are built to match). */
export const WIDTH_RATIO: Record<string, number> = {
  tower_crane: 0.8, small_crane: 0.8, skyscraper: 0.24, half_built_tower: 0.26, house_row: 3.2, tree: 0.7, person: 0.3, ship: 5, mountain: 2.2,
};
/** Where on a tower crane's jib the hook hangs, as fractions of the crane height (x from the mast, y up from the ground). */
export const HOOK_X = 0.32;
/** Trolley height on a crane (fraction of its height) and how far under it a load's top hangs. */
export const HOOK_Y_TOP = 0.92;
export const LOAD_DROP = 0.3;

// ---- beat timing ----
/** Start frame and length of each beat. Rounded on the running total so the beats add up to exactly the video length. */
export function beatFrames(durationsS: readonly number[], fps: number): { from: number; frames: number }[] {
  let acc = 0;
  let prev = 0;
  return durationsS.map((d) => {
    acc += d;
    const end = Math.round(acc * fps);
    const out = { from: prev, frames: Math.max(1, end - prev) };
    prev = end;
    return out;
  });
}
export const totalFrames = (durationsS: readonly number[], fps: number): number => {
  const b = beatFrames(durationsS, fps);
  const last = b[b.length - 1];
  return last ? last.from + last.frames : 0;
};
export function beatIndexAt(frames: readonly { from: number; frames: number }[], frame: number): number {
  for (let i = 0; i < frames.length; i++) if (frame < frames[i]!.from + frames[i]!.frames) return i;
  return frames.length - 1;
}

// ---- labels ----
/** "1.7 m", "79 m", "330 m", "1.2 km", "8,849 m" is shown as "8.8 km". Thousands switch to km. */
export function formatHeight(m: number): string {
  const v = Math.max(0, m);
  const r = v < 10 ? Math.round(v * 10) / 10 : Math.round(v);
  if (r >= 1000) {
    const km = r / 1000;
    return `${km >= 10 ? Math.round(km) : Math.round(km * 10) / 10} km`;
  }
  return `${r} m`;
}

// ---- layout ----
export type Placement = { id: string; x: number; z: number; y: number; width: number; height: number; carriedBy?: string };

/** The hook's x for a crane placement: at the trolley, a fixed fraction of the crane height out along the jib. */
export const hookX = (crane: Placement): number => crane.x + HOOK_X * crane.height;

/**
 * Objects stand in a row left to right in the given order. Gaps scale with the bigger neighbour, so a big object is far
 * from a small one sideways, and big objects stand further back (z) so they are small in a mid-shot of something else.
 * An object on a crane's hook is not in the row: it hangs under the hook.
 */
export function layoutObjects(objects: readonly MObject[]): Placement[] {
  const carried = new Set(objects.map((o) => o.carries).filter((c): c is string => !!c));
  const out: Placement[] = [];
  let prev: Placement | undefined;
  for (const o of objects) {
    if (carried.has(o.id)) continue;
    const width = o.height_m * (WIDTH_RATIO[o.kind] ?? 0.5);
    const gap = prev ? 0.35 * Math.max(prev.height, o.height_m) + 2 : 0;
    const x = prev ? prev.x + prev.width / 2 + gap + width / 2 : 0;
    const p: Placement = { id: o.id, x, z: -0.9 * o.height_m * (o.kind === "mountain" ? 1.2 : 1), y: 0, width, height: o.height_m };
    out.push(p);
    prev = p;
  }
  for (const o of objects) {
    if (!o.carries) continue;
    const crane = out.find((p) => p.id === o.id);
    const load = objects.find((x) => x.id === o.carries);
    if (!crane || !load) continue;
    const width = load.height_m * (WIDTH_RATIO[load.kind] ?? 0.5);
    // The load hangs on slings below the hook: its top is LOAD_DROP of the crane's height under the trolley.
    out.push({ id: load.id, x: hookX(crane), z: crane.z, y: (HOOK_Y_TOP - LOAD_DROP) * crane.height - load.height_m, width, height: load.height_m, carriedBy: crane.id });
  }
  return out;
}

// ---- camera path ----
/** `top` is the highest height this shot cares about: the ruler's visible range follows it. */
export type CamKey = { t: number; x: number; y: number; z: number; dist: number; top: number };
export type CamPose = { x: number; y: number; z: number; dist: number };

/** Distance from the focus plane at which `span` metres fill the screen's height. */
export const distForSpan = (span: number): number => span / (2 * TAN_HALF_FOV);

/** How many metres of height a beat shows, derived from the focus object's size (never from the biggest object in the scene). */
export function beatSpan(o: MObject, range?: [number, number]): number {
  const w = o.height_m * (WIDTH_RATIO[o.kind] ?? 0.5);
  if (range) return Math.max((Math.abs(range[1] - range[0])) * 0.55, o.height_m * 0.12, 3);
  // Wide things (a ship, a house row) may be cropped a little at the sides rather than shrunk to fit the narrow frame.
  return Math.max(o.height_m * 1.35, (w * 0.6) / ASPECT);
}

/**
 * Camera keys in seconds. A whole-object beat is one key at the beat's middle; a climb (range_m) is two keys, near the
 * start and the end of the beat, so the camera is moving through the middle. The camera height is the real height.
 * If loop_back, the path ends where it began.
 */
export function cameraKeys(scene: MScene, placements: readonly Placement[]): CamKey[] {
  const keys: CamKey[] = [];
  let t0 = 0;
  const make = (p: Placement, y: number, span: number, t: number, top: number): CamKey => {
    // A load on a hook floats, so the camera follows it up there instead of keeping the ground in view.
    const cy = p.carriedBy ? p.y + y : y;
    return { t, x: p.x, y: cy, z: p.z, dist: distForSpan(span), top: Math.max(top + (p.carriedBy ? p.y : 0), cy * 1.15) };
  };
  for (const b of scene.beats) {
    const o = scene.objects.find((x) => x.id === b.focus);
    const p = placements.find((x) => x.id === b.focus);
    if (!o || !p) throw new Error(`beat focuses on unknown object "${b.focus}"`);
    const span = beatSpan(o, b.range_m);
    if (b.range_m) {
      const [lo, hi] = b.range_m[0] <= b.range_m[1] ? b.range_m : [b.range_m[1], b.range_m[0]];
      // a climb never lets the ground rise above the lower part of the frame
      keys.push(make(p, Math.max(lo, span * 0.42), span, t0 + b.duration_s * 0.12, hi * 1.2), make(p, hi, span, t0 + b.duration_s * 0.88, hi * 1.2));
    } else {
      // the object sits a little below the middle of the frame
      keys.push(make(p, o.height_m / 2 + span * 0.1, span, t0 + b.duration_s * 0.5, o.height_m * 1.6));
    }
    t0 += b.duration_s;
  }
  const first = keys[0]!;
  const last = keys[keys.length - 1]!;
  return [{ ...first, t: 0 }, ...keys, scene.loop_back === false ? { ...last, t: t0 } : { ...first, t: t0 }];
}

/**
 * Monotone cubic (Fritsch-Carlson) through the keys, per channel: smooth and velocity-continuous across every key, so the
 * camera glides through a beat boundary instead of easing to a stop; it never overshoots a key. Held before and after the ends.
 */
function monotone(ts: readonly number[], vs: readonly number[], t: number): number {
  const n = ts.length;
  if (t <= ts[0]!) return vs[0]!;
  if (t >= ts[n - 1]!) return vs[n - 1]!;
  let i = 0;
  while (i < n - 2 && t > ts[i + 1]!) i++;
  const h = (k: number) => ts[k + 1]! - ts[k]!;
  const d = (k: number) => (vs[k + 1]! - vs[k]!) / h(k);
  const slope = (k: number): number => {
    if (k === 0 || k === n - 1) return 0; // rest at both ends (also makes the loop seamless)
    const a = d(k - 1);
    const b = d(k);
    if (a * b <= 0) return 0;
    const w1 = 2 * h(k) + h(k - 1);
    const w2 = h(k) + 2 * h(k - 1);
    return (w1 + w2) / (w1 / a + w2 / b);
  };
  const m0 = slope(i);
  const m1 = slope(i + 1);
  const hh = h(i);
  const s = (t - ts[i]!) / hh;
  const s2 = s * s;
  const s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * vs[i]! + (s3 - 2 * s2 + s) * hh * m0 + (-2 * s3 + 3 * s2) * vs[i + 1]! + (s3 - s2) * hh * m1;
}

/** Camera focus point and distance at time `tS`. Zoom (distance) is blended in log space so it feels even. */
export function cameraAt(keys: readonly CamKey[], tS: number): CamPose {
  // Keys sharing a time would divide by zero; the builder never makes them, but drop them defensively.
  const ks = keys.filter((k, i) => i === 0 || k.t > keys[i - 1]!.t);
  const ts = ks.map((k) => k.t);
  return {
    x: monotone(ts, ks.map((k) => k.x), tS),
    y: monotone(ts, ks.map((k) => k.y), tS),
    z: monotone(ts, ks.map((k) => k.z), tS),
    dist: Math.exp(monotone(ts, ks.map((k) => Math.log(k.dist)), tS)),
  };
}

/** The camera's position in the world: the focus point, pulled back by `dist` along a fixed sideways angle. The height equals the focus height. */
export const cameraPosition = (c: CamPose): { x: number; y: number; z: number } => ({
  x: c.x + c.dist * Math.sin(YAW_RAD),
  y: c.y,
  z: c.z + c.dist * Math.cos(YAW_RAD),
});

// ---- ruler ----
/** The ruler shows the camera's real height, not the time. */
export const rulerValue = (c: CamPose): number => cameraPosition(c).y;

const NICE = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
/** Round up to a tidy 1, 1.5, 2, 2.5, 3, 4, 5, 6 or 8 times a power of ten. */
export function niceCeil(v: number): number {
  const p = 10 ** Math.floor(Math.log10(Math.max(v, 1e-9)));
  return (NICE.find((n) => n * p >= v - 1e-9) ?? 10) * p;
}
/**
 * The ruler's visible range (0 to this many metres) at time `tS`: follows the focus, so a street shows 0 to about 15 m and a
 * tower 0 to about 500 m. Blended in log space, so it zooms smoothly across beats. `ruler.max_m` fixes it instead.
 */
export function rulerRangeAt(scene: MScene, keys: readonly CamKey[], tS: number): number {
  if (scene.ruler?.max_m) return scene.ruler.max_m;
  const ks = keys.filter((k, i) => i === 0 || k.t > keys[i - 1]!.t);
  const r = Math.exp(monotone(ks.map((k) => k.t), ks.map((k) => Math.log(Math.max(1, k.top))), tS));
  return Math.max(1, r, cameraAt(keys, tS).y * 1.1); // the marker is always on the ruler
}
/** Tick spacing for a visible range: tidy steps (1, 2, 5, 10, 20 ... m), about 4 to 8 ticks. */
export function rulerStep(range: number): number {
  const x = range / 8;
  const p = 10 ** Math.floor(Math.log10(Math.max(x, 1e-9)));
  return ([1, 2, 5, 10].find((n) => n * p >= x - 1e-9) ?? 10) * p;
}
