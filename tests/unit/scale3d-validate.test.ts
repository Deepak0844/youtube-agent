import { describe, expect, it } from "vitest";
import { SCALE3D_SAMPLE, validateScale3d, type Scale3dScene } from "../../src/shared/scale3d";

const clone = (): Scale3dScene => structuredClone(SCALE3D_SAMPLE);
const errorsOf = (v: unknown): string[] => {
  const r = validateScale3d(v);
  return r.ok ? [] : r.errors;
};

describe("validateScale3d", () => {
  it("accepts the sample and reports its length", () => {
    const r = validateScale3d(SCALE3D_SAMPLE);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.totalS).toBe(34);
  });
  it("rejects a runtime that is too short or too long", () => {
    const s = clone();
    s.beats.forEach((b) => (b.duration_s = 2));
    expect(errorsOf(s).join(" ")).toMatch(/must run 30 to 45 s/);
    const l = clone();
    l.beats.forEach((b) => (b.duration_s = 10));
    expect(errorsOf(l).join(" ")).toMatch(/add up to 60 s/);
  });
  it("needs a source or a method for every height", () => {
    const s = clone() as unknown as { objects: Record<string, unknown>[] };
    delete s.objects[0]!.claim;
    expect(errorsOf(s).length).toBeGreaterThan(0);
    s.objects[0]!.claim = { source_url: "https://example.com", quote: "ok quote", method: "both" };
    expect(errorsOf(s).length).toBeGreaterThan(0);
  });
  it("rejects an unknown kind, duplicate ids and unknown beat focus", () => {
    const k = clone() as unknown as { objects: Record<string, unknown>[] };
    k.objects[1]!.kind = "spaceship";
    expect(errorsOf(k).length).toBeGreaterThan(0);
    const d = clone();
    d.objects[2]!.id = "crane";
    expect(errorsOf(d).join(" ")).toMatch(/share the same id/);
    const f = clone();
    f.beats[0]!.focus = "ghost";
    expect(errorsOf(f).join(" ")).toMatch(/Beat 1 focuses on "ghost"/);
  });
  it("checks the load on a crane", () => {
    const big = clone();
    big.objects[1]!.height_m = 60;
    expect(errorsOf(big).join(" ")).toMatch(/too big/);
    const notCrane = clone();
    notCrane.objects[2]!.carries = "mini";
    expect(errorsOf(notCrane).join(" ")).toMatch(/only a tower_crane/);
  });
  it("checks climb ranges", () => {
    const up = clone();
    up.beats[1]!.range_m = [50, 10];
    expect(errorsOf(up).join(" ")).toMatch(/lower height to a higher/);
    const tall = clone();
    tall.beats[1]!.range_m = [0, 200];
    expect(errorsOf(tall).join(" ")).toMatch(/only 79 m tall/);
  });
  it("enforces object and beat counts", () => {
    const o = clone();
    o.objects = Array.from({ length: 13 }, (_, i) => ({ ...SCALE3D_SAMPLE.objects[2]!, id: `h${i}` }));
    expect(errorsOf(o).length).toBeGreaterThan(0);
    const b = clone();
    b.beats = Array.from({ length: 13 }, () => ({ ...SCALE3D_SAMPLE.beats[0]!, duration_s: 3 }));
    expect(errorsOf(b).length).toBeGreaterThan(0);
  });
  it("rejects extra fields (no free-form code can ride along)", () => {
    const s = clone() as unknown as Record<string, unknown>;
    s.script = "alert(1)";
    expect(errorsOf(s).length).toBeGreaterThan(0);
  });
});
