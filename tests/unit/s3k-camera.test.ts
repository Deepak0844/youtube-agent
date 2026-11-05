import { describe, expect, it } from "vitest";
import { coverage, frameFocus, glideTimes, heroWeight, resolveShots, rigPose, safeFor, type Box } from "../../remotion/kit/s3k/framing";
import { strataUV, TILT_LIMIT_DEG } from "../../remotion/kit/s3k/Cutaway";

const BOX: Box = { min: [-20, -10, -5], max: [20, 6, 5] };
const ASPECTS = [9 / 16, 4 / 5, 1, 16 / 9];

describe("portrait-aware framing", () => {
  it("fits the focus box inside the safe area at several aspect ratios", () => {
    for (const aspect of ASPECTS) {
      const f = frameFocus({ box: BOX, yawDeg: 15, pitchDeg: 12, aspect });
      expect(f.coverage.fits, `aspect ${aspect}`).toBe(true);
      expect(f.coverage.fill).toBeLessThanOrEqual(1.001);
      expect(f.coverage.fill).toBeGreaterThan(0.9); // the nearest camera that fits: the box fills the safe area on its tight side
    }
  });
  it("keeps the caption margin free at the top of a portrait frame", () => {
    const f = frameFocus({ box: BOX, yawDeg: 0, pitchDeg: 10, aspect: 9 / 16 });
    const c = coverage(BOX, f.position, f.target, 9 / 16, safeFor(9 / 16));
    expect(c.fits).toBe(true);
    // a tighter safe area (bigger top margin) pushes the camera back
    const far = frameFocus({ box: BOX, yawDeg: 0, pitchDeg: 10, aspect: 9 / 16, safe: { top: 0.4, bottom: 0.1, left: 0.06, right: 0.06 } });
    expect(Math.hypot(...far.position.map((v, i) => v - far.target[i]!) as [number, number, number])).toBeGreaterThan(Math.hypot(...f.position.map((v, i) => v - f.target[i]!) as [number, number, number]));
  });
  it("never puts the eye below the ground: it tilts up instead", () => {
    const low = frameFocus({ box: { min: [-20, 0, -5], max: [20, 6, 5] }, yawDeg: 0, pitchDeg: 0, aspect: 9 / 16, minY: 8 });
    expect(low.position[1]).toBeGreaterThanOrEqual(8);
    expect(low.pitchDeg).toBeGreaterThan(0);
    expect(low.coverage.fits).toBe(true);
  });
  it("distanceMul > 1 pulls back", () => {
    const a = frameFocus({ box: BOX, yawDeg: 0, pitchDeg: 10, aspect: 9 / 16 });
    const b = frameFocus({ box: BOX, yawDeg: 0, pitchDeg: 10, aspect: 9 / 16, distanceMul: 1.5 });
    expect(b.coverage.fill).toBeLessThan(a.coverage.fill);
  });
});

describe("rig spline", () => {
  const shots = [
    { t: 0, at: [0, 5, 30] as [number, number, number], look: [0, 0, 0] as [number, number, number] },
    { t: 4, at: [10, 1, 20] as [number, number, number], look: [5, 0, 0] as [number, number, number] },
    { t: 10, at: [30, 3, 10] as [number, number, number], look: [10, 0, 0] as [number, number, number] },
  ];
  const keys = resolveShots(shots, 9 / 16).map((r) => r.key);
  it("passes through every key and rests at both ends", () => {
    for (const k of keys) expect(rigPose(keys, k.t).position).toEqual(k.position);
    const e = 0.01;
    const d = (a: number, b: number) => Math.hypot(...rigPose(keys, a).position.map((v, i) => v - rigPose(keys, b).position[i]!));
    expect(d(0, e)).toBeLessThan(0.01);
    expect(d(10 - e, 10)).toBeLessThan(0.01);
  });
  it("is monotone between keys on x: it never swings back (no stop-and-go)", () => {
    let prev = -Infinity;
    for (let t = 0; t <= 10; t += 0.1) { const x = rigPose(keys, t).position[0]; expect(x).toBeGreaterThanOrEqual(prev - 1e-9); prev = x; }
  });
  it("stays above the floor", () => {
    for (let t = 0; t <= 10; t += 0.25) expect(rigPose(keys, t, 2).position[1]).toBeGreaterThanOrEqual(2);
    for (let t = 0; t <= 10; t += 0.25) expect(rigPose(keys, t, (x) => x * 0.1 + 1).position[1]).toBeGreaterThanOrEqual(1);
  });
  it("rejects shots whose times do not increase", () => {
    expect(() => resolveShots([shots[1]!, shots[0]!], 9 / 16)).toThrow(/greater/);
  });
  it("resolves frame shots with a coverage report", () => {
    const r = resolveShots([{ t: 0, frame: { box: BOX, yawDeg: 0, pitchDeg: 10 } }, shots[2]!], 9 / 16);
    expect(r[0]!.coverage?.fits).toBe(true);
    expect(r[1]!.coverage).toBeNull();
  });
  it("hero lock leans the look-at point to the hero and eases in and out", () => {
    const hero = { at: () => [100, 0, 0] as [number, number, number], from: 2, to: 8, strength: 1, fade: 1 };
    expect(heroWeight(0, hero)).toBe(0);
    expect(heroWeight(5, hero)).toBeCloseTo(1, 5);
    expect(heroWeight(9, hero)).toBe(0);
    expect(rigPose(keys, 5, -Infinity, hero).target[0]).toBeCloseTo(100, 3);
    expect(rigPose(keys, 0, -Infinity, hero).target[0]).toBeCloseTo(0, 3);
  });
});

describe("glideTimes", () => {
  it("starts at 0, ends at the duration, increases, and is slow at the ends", () => {
    const t = glideTimes(5, 20);
    expect(t[0]).toBeCloseTo(0, 3);
    expect(t[4]).toBeCloseTo(20, 3);
    for (let i = 1; i < t.length; i++) expect(t[i]!).toBeGreaterThan(t[i - 1]!);
    expect(t[1]! - t[0]!).toBeGreaterThan(t[2]! - t[1]!); // the first gap is the longest: a gentle start
  });
});

describe("strata UVs are world aligned", () => {
  it("one tile covers `tile` metres, and tilt shears the layers", () => {
    expect(strataUV(52, -52, 52, 0)).toEqual([1, 0]);
    const [, v0] = strataUV(0, 0, 52, 10);
    const [, v1] = strataUV(52, 0, 52, 10);
    expect(v0 - v1).toBeCloseTo(Math.tan((10 * Math.PI) / 180), 6);
    expect(strataUV(10, 0, 52, 99)[1]).toBeCloseTo(strataUV(10, 0, 52, TILT_LIMIT_DEG)[1], 9); // clamped
  });
});
