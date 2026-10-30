import { describe, expect, it } from "vitest";
import { validateScenes } from "@/shared/scene";
import { kitProject, orbitPoint, REGIONS, resolveBodies } from "../../../remotion/kit/helpers";

const o = { id: "s1", beat: "b1", kind: "orbit", startMs: 0, durationMs: 3000, preset: "solar_system" };
const m = { id: "s2", beat: "b2", kind: "map", startMs: 3000, durationMs: 3000, region: "world", markers: [{ label: "Paris", lat: 48.85, lon: 2.35 }] };
const doc = (...scenes: unknown[]) => ({ version: 1, scenes });
const errs = (d: unknown) => {
  const r = validateScenes(d);
  return r.ok ? [] : r.errors;
};
const body = (i: number) => ({ label: `b${i}`, radius: 3, periodS: 10 });

describe("orbit scene", () => {
  it("accepts presets and fills defaults", () => {
    expect(validateScenes(doc(o, m)).ok).toBe(true);
  });
  it("custom needs bodies, presets do not", () => {
    expect(errs(doc({ ...o, preset: "custom" }))[0]).toContain("bodies");
    expect(errs(doc({ ...o, preset: "custom", bodies: [body(1)] }))).toEqual([]);
  });
  it("bounds bodies, radius, period, label", () => {
    expect(errs(doc({ ...o, preset: "custom", bodies: Array.from({ length: 7 }, (_, i) => body(i)) }))[0]).toContain("at most 6");
    expect(errs(doc({ ...o, preset: "custom", bodies: [{ ...body(1), radius: 11 }] }))[0]).toContain("radius");
    expect(errs(doc({ ...o, preset: "custom", bodies: [{ ...body(1), periodS: 0.5 }] }))[0]).toContain("periodS");
    expect(errs(doc({ ...o, preset: "custom", bodies: [{ ...body(1), label: "x".repeat(13) }] }))[0]).toContain("at most 12");
    expect(errs(doc({ ...o, preset: "nebula" })).length).toBe(1);
  });
});

describe("map scene", () => {
  it("rejects bad lat/lon with plain text", () => {
    expect(errs(doc({ ...m, markers: [{ label: "A", lat: 91, lon: 0 }] }))[0]).toBe("scene 1 > markers > 0 > lat: must be between -90 and 90");
    expect(errs(doc({ ...m, markers: [{ label: "A", lat: 0, lon: -181 }] }))[0]).toBe("scene 1 > markers > 0 > lon: must be between -180 and 180");
  });
  it("bounds markers and region", () => {
    expect(errs(doc({ ...m, markers: [] })).length).toBe(1);
    expect(errs(doc({ ...m, markers: Array.from({ length: 7 }, () => ({ label: "A", lat: 0, lon: 0 })) }))[0]).toContain("at most 6");
    expect(errs(doc({ ...m, region: "mars" })).length).toBe(1);
    expect(errs(doc({ ...m, route: true }))).toEqual([]);
  });
});

describe("orbit and map helpers", () => {
  it("orbitPoint is on the ellipse and returns after one period", () => {
    const [x0, y0] = orbitPoint(0, 30, 10, 100, 50, 0);
    expect([x0, y0]).toEqual([100, 0]);
    const [x1, y1] = orbitPoint(300, 30, 10, 100, 50, 0);
    expect(x1).toBeCloseTo(100);
    expect(y1).toBeCloseTo(0);
  });
  it("resolveBodies uses preset bodies unless custom", () => {
    expect(resolveBodies("moon_earth", undefined).length).toBe(1);
    expect(resolveBodies("solar_system", undefined).length).toBeGreaterThan(3);
    expect(resolveBodies("custom", [body(1)])[0]?.label).toBe("b1");
  });
  it("kitProject keeps region corners inside the box", () => {
    for (const r of Object.keys(REGIONS) as (keyof typeof REGIONS)[]) {
      const [lo, la, hi, ha] = REGIONS[r];
      for (const [lon, lat] of [[lo, la], [hi, ha]] as const) {
        const [x, y] = kitProject(r, lon, lat, 900, 700);
        expect(x).toBeGreaterThanOrEqual(-0.001);
        expect(x).toBeLessThanOrEqual(900.001);
        expect(y).toBeGreaterThanOrEqual(-0.001);
        expect(y).toBeLessThanOrEqual(700.001);
      }
    }
  });
});
