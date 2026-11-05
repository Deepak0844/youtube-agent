// Tiny pure helpers shared by every s3k file: a seeded random generator (same seed, same picture on every frame and every machine),
// clamp and the smooth ease used for captions and motion. No three.js here, so unit tests can load it.

/** Seeded random generator (mulberry32): `const r = rnd(7); r()` gives 0..1. Never use Math.random in a scene: frames must repeat. */
export const rnd = (seed: number): (() => number) => {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const clamp = (x: number, lo = 0, hi = 1): number => Math.min(hi, Math.max(lo, x));
export const lerp = (a: number, b: number, u: number): number => a + (b - a) * u;
/** Smootherstep 0..1 (flat at both ends). */
export const smooth = (x: number): number => {
  const u = clamp(x);
  return u * u * u * (u * (u * 6 - 15) + 10);
};
/** Progress of t through [a, b] as 0..1 (clamped): the way to time anything. `ramp(t, 4, 6)` is 0 before 4 s, 1 after 6 s. */
export const ramp = (t: number, a: number, b: number): number => clamp((t - a) / (b - a));
