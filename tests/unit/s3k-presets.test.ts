import { describe, expect, it } from "vitest";
import { floaters, fitSunFrustum, PRESET_NAMES, presetProblems, resolvePreset, restOffset, sunVector, WORLD_PRESETS } from "../../remotion/kit/s3k/presets";
import { FINISH_DEFAULTS, resolveFinish } from "../../remotion/kit/s3k/finish-math";

describe("world presets", () => {
  it("has the four looks and every one is valid", () => {
    expect([...PRESET_NAMES].sort()).toEqual(["clear", "dusk", "haze", "overcast", "studio"]);
    for (const n of PRESET_NAMES) expect(presetProblems(WORLD_PRESETS[n]), n).toEqual([]);
  });
  it("keeps the approved proof look as the default (haze)", () => {
    const p = resolvePreset();
    expect(p.fog).toBe("#d6e6ee");
    expect(p.fogDensity).toBe(0.0034);
    expect(p.sunIntensity).toBe(3.3);
  });
  it("rejects out-of-range tweaks with a clear message", () => {
    expect(() => resolvePreset("haze", { fogDensity: 0.5 })).toThrow(/fogDensity/);
    expect(() => resolvePreset("clear", { sunElevationDeg: -5 })).toThrow(/sunElevationDeg/);
    expect(() => resolvePreset("dusk", { fog: "blue" })).toThrow(/colour/);
    expect(resolvePreset("dusk", { fogDensity: 0.001 }).fogDensity).toBe(0.001);
  });
  it("sun vector is a unit vector pointing up", () => {
    const v = sunVector(-41.6, 43.3);
    expect(Math.hypot(...v)).toBeCloseTo(1, 6);
    expect(v[1]).toBeCloseTo(Math.sin((43.3 * Math.PI) / 180), 6);
  });
});

describe("sun shadow frustum fitted to a focus box", () => {
  const box = { min: [-50, -20, -30] as [number, number, number], max: [30, 25, 40] as [number, number, number] };
  for (const name of PRESET_NAMES) {
    it(`covers every corner of the box (${name})`, () => {
      const p = WORLD_PRESETS[name];
      const dir = sunVector(p.sunAzimuthDeg, p.sunElevationDeg);
      const f = fitSunFrustum(box, dir);
      const fwd = dir.map((v) => -v) as [number, number, number];
      const r = (() => { const c = [fwd[1] * 0 - fwd[2] * 1, fwd[2] * 0 - fwd[0] * 0, fwd[0] * 1 - fwd[1] * 0]; const l = Math.hypot(c[0]!, c[1]!, c[2]!); return c.map((v) => v / l) as [number, number, number]; })();
      const u = [r[1] * fwd[2] - r[2] * fwd[1], r[2] * fwd[0] - r[0] * fwd[2], r[0] * fwd[1] - r[1] * fwd[0]] as [number, number, number];
      const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
      for (const x of [box.min[0], box.max[0]]) for (const y of [box.min[1], box.max[1]]) for (const z of [box.min[2], box.max[2]]) {
        const d = [x - f.position[0], y - f.position[1], z - f.position[2]];
        const rr = dot(d, r), uu = dot(d, u), depth = dot(d, fwd);
        expect(rr).toBeGreaterThanOrEqual(f.left - 1e-6); expect(rr).toBeLessThanOrEqual(f.right + 1e-6);
        expect(uu).toBeGreaterThanOrEqual(f.bottom - 1e-6); expect(uu).toBeLessThanOrEqual(f.top + 1e-6);
        expect(depth).toBeGreaterThanOrEqual(f.near); expect(depth).toBeLessThanOrEqual(f.far);
      }
    });
  }
});

describe("nothing floats", () => {
  it("restOffset puts the lowest point on the plane", () => {
    expect(restOffset(2.5, 0)).toBe(-2.5);
    expect(restOffset(-1, 0.2, 0.03)).toBeCloseTo(1.23, 9);
  });
  it("floaters names what is off its plane by more than the tolerance", () => {
    expect(floaters([{ name: "ok", minY: 0.01, planeY: 0 }, { name: "high", minY: 1, planeY: 0 }, { name: "sunk", minY: -0.5, planeY: 0 }])).toEqual(["high", "sunk"]);
  });
});

describe("finish knobs", () => {
  it("defaults are the proof's and fast mode drops AO and depth of field", () => {
    const f = resolveFinish({});
    expect(f).toMatchObject({ ao: true, dof: 1, bloom: FINISH_DEFAULTS.bloom, vignette: 0.42, samples: 4 });
    expect(resolveFinish({ mode: "fast" })).toMatchObject({ ao: false, dof: 0, samples: 2 });
  });
  it("clamps wild values into their limits", () => {
    expect(resolveFinish({ dof: 99, bloom: -3, vignette: 5, saturation: Number.NaN })).toMatchObject({ dof: 3, bloom: 0, vignette: 0.8, saturation: 0.5 });
  });
});
