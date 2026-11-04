import { describe, expect, it } from "vitest";
import { withDefaults } from "../../remotion/kit/scene3d/defaults";
import { animAt, boxCenter, cameraAt, cameraKeys, clampAbove, ease, fits, focusBox, frameBox, groundHeightAt, pointOnPath, SCENE3D_DEMO, scene3dSchema, shotAt, type Box } from "../../src/shared/scene3d";

const scene = scene3dSchema.parse(SCENE3D_DEMO);

describe("defaults without zod", () => {
  it("gives exactly what the schema gives", () => {
    expect(withDefaults(SCENE3D_DEMO)).toEqual(scene);
  });
});

describe("easing and animation", () => {
  it("every ease starts at 0, ends at 1 and clamps outside", () => {
    for (const k of ["linear", "in", "out", "in_out", "back_out"] as const) {
      expect(ease(k, 0)).toBeCloseTo(0, 6);
      expect(ease(k, 1)).toBeCloseTo(1, 6);
      expect(ease(k, -3)).toBeCloseTo(0, 6);
      expect(ease(k, 9)).toBeCloseTo(1, 6);
    }
  });
  it("in_out is monotone and back_out overshoots", () => {
    let prev = -1;
    for (let i = 0; i <= 50; i++) { const v = ease("in_out", i / 50); expect(v).toBeGreaterThanOrEqual(prev); prev = v; }
    expect(Math.max(...Array.from({ length: 50 }, (_, i) => ease("back_out", i / 50)))).toBeGreaterThan(1.05);
  });
  it("walks a path by arc length and faces along it", () => {
    const p = [[0, 0], [10, 0], [10, 10]] as const;
    expect(pointOnPath(p, 0.25)).toMatchObject({ x: 5, z: 0 });
    expect(pointOnPath(p, 0.75).z).toBeCloseTo(5);
    expect(pointOnPath(p, 1)).toMatchObject({ x: 10, z: 10 });
    expect(pointOnPath(p, 0.1).heading).toBeCloseTo(0);
  });
  it("combines animations at a time", () => {
    const s = animAt(
      [
        { type: "grow", from_scale: 0, start_s: 0, duration_s: 2, ease: "linear" },
        { type: "rotate", degrees: 90, start_s: 0, duration_s: 2, ease: "linear" },
        { type: "build_up", start_s: 1, duration_s: 2, ease: "linear" },
        { type: "pour", from: [1, 2, 3], start_s: 0, duration_s: 4, ease: "linear" },
      ],
      1,
    );
    expect(s.scale).toBeCloseTo(0.5);
    expect(s.yaw).toBeCloseTo(Math.PI / 4);
    expect(s.build).toBeCloseTo(0);
    expect(s.pour).toBeCloseTo(0.25);
    expect(s.pourFrom).toEqual([1, 2, 3]);
    expect(animAt([], 5)).toMatchObject({ scale: 1, build: 1, pour: null });
  });
  it("snaps to the highest ground under a point", () => {
    expect(groundHeightAt(scene, -50, 0)).toBe(1); // on the land slab
    expect(groundHeightAt(scene, 200, 0)).toBe(0); // open water: world ground is none, so 0
    expect(groundHeightAt(scene, 0, -400)).toBeCloseTo(0.4); // the plain
  });
});

const box: Box = { min: [-10, 0, -4], max: [10, 12, 4] };
describe("framing", () => {
  for (const aspect of [9 / 16, 1, 16 / 9, 4 / 5]) {
    for (const [yaw, pitch] of [[0, 20], [35, 28], [-70, 55]] as const) {
      it(`fits the box in the safe area (aspect ${aspect.toFixed(2)}, yaw ${yaw}, pitch ${pitch}) and is the nearest such camera`, () => {
        const f = frameBox({ box, yawDeg: yaw, pitchDeg: pitch, aspect });
        const safe = aspect < 1 ? { top: 0.24, bottom: 0.1, left: 0.06, right: 0.06 } : { top: 0.14, bottom: 0.12, left: 0.08, right: 0.08 };
        expect(fits(box, f.position, f.target, 40, aspect, safe)).toBe(true);
        // A camera 5% closer on the same line no longer fits.
        const c = boxCenter(box);
        const closer = f.position.map((v, i) => c[i]! + (v - c[i]!) * 0.95) as [number, number, number];
        expect(fits(box, closer, f.target, 40, aspect, safe)).toBe(false);
      });
    }
  }
  it("a tall thin box in portrait is limited by height, a wide one by width", () => {
    const tall = frameBox({ box: { min: [-1, 0, -1], max: [1, 40, 1] }, yawDeg: 0, pitchDeg: 5, aspect: 9 / 16 });
    const wide = frameBox({ box: { min: [-40, 0, -1], max: [40, 2, 1] }, yawDeg: 0, pitchDeg: 5, aspect: 9 / 16 });
    expect(tall.distance).toBeGreaterThan(50);
    expect(wide.distance).toBeGreaterThan(tall.distance); // 80 m across needs more room than 40 m up in a 9:16 frame
  });
  it("finds boxes for demo focus lists and clampAbove never goes below the floor", () => {
    expect(focusBox(scene, ["barge", "mound"])).not.toBeNull();
    expect(focusBox(scene, "missing")).toBeNull();
    for (const y of [-50, -1, 0, 0.5, 3, 100]) expect(clampAbove(y, 2, 1.5)).toBeGreaterThanOrEqual(2);
    expect(clampAbove(100, 2, 1.5)).toBeCloseTo(100, 0);
  });
});

describe("camera path", () => {
  const keys = cameraKeys(scene, 9 / 16);
  const total = scene.shots.reduce((a, s) => a + s.duration_s, 0);
  const dt = 1 / 30;
  const pos = (t: number) => cameraAt(keys, t).position;
  const speed = (t: number) => { const a = pos(t - dt / 2); const b = pos(t + dt / 2); return a.map((v, i) => (b[i]! - v) / dt) as [number, number, number]; };

  it("starts and ends at rest", () => {
    expect(Math.hypot(...speed(0.01))).toBeLessThan(0.5);
    expect(Math.hypot(...speed(total - 0.01))).toBeLessThan(0.5);
  });
  it("has no velocity jumps, including across shot cuts", () => {
    let prev = speed(dt);
    let worst = 0;
    let top = 0;
    for (let t = 2 * dt; t < total - dt; t += dt) {
      const v = speed(t);
      worst = Math.max(worst, Math.hypot(v[0] - prev[0], v[1] - prev[1], v[2] - prev[2]));
      top = Math.max(top, Math.hypot(...v));
      prev = v;
    }
    // Change of velocity from one frame to the next, against the top speed. A cut or a stop-and-go would be a big share of it.
    expect(worst / top).toBeLessThan(0.15);
  });
  it("is continuous at the shot boundaries (no teleport)", () => {
    let acc = 0;
    for (const s of scene.shots.slice(0, -1)) {
      acc += s.duration_s;
      const a = pos(acc - 1e-3);
      const b = pos(acc + 1e-3);
      const v = Math.hypot(...speed(acc));
      expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeLessThan(v * 2e-3 * 1.5 + 1e-6);
    }
  });
  it("never dips below the floor it is given", () => {
    for (let t = 0; t < total; t += 0.05) expect(cameraAt(keys, t, 5).position[1]).toBeGreaterThanOrEqual(5);
  });
  it("tells which shot is on screen", () => {
    expect(shotAt(scene.shots, 0).index).toBe(0);
    expect(shotAt(scene.shots, 3.1).index).toBe(1);
    expect(shotAt(scene.shots, 99).index).toBe(scene.shots.length - 1);
    expect(shotAt(scene.shots, 3.5).local).toBeCloseTo(0.5);
  });
});
