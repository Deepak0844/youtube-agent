import { describe, expect, it } from "vitest";
import { retimeScene3d, scene3dSchema, shotBeatId, shotsTotalS, type Scene3d } from "@/shared/scene3d";

const IDS = ["hook", "setup", "dig", "load", "pour", "reveal", "loop"];
const make = (shots: Array<{ id: string; duration_s: number }>, anim = true): Scene3d =>
  scene3dSchema.parse({
    version: 2,
    elements: [
      { kind: "water", id: "sea", size_m: [400, 200] },
      { kind: "box", id: "b", size_m: [1, 1, 1], animations: anim ? [{ type: "rotate", degrees: 90, start_s: 40, duration_s: 10 }] : [] },
    ],
    shots: shots.map((s) => ({ ...s, focus: "b" })),
  });
const eight = () => make(IDS.map((id) => ({ id, duration_s: 8 })));
// 7 beats x 10 words; a word every 0.4 s from 0.2 s -> 70 words, last ends at 28 s
const beats = IDS.map((id) => ({ id, words: 10 }));
const words = (n = 70, step = 0.4) => Array.from({ length: n }, (_, i) => ({ startS: 0.2 + i * step, endS: 0.2 + i * step + 0.3 }));
const ok = (r: ReturnType<typeof retimeScene3d>) => {
  if (!r.ok) throw new Error(r.reason);
  return r;
};

describe("retimeScene3d", () => {
  it("starts each beat's shot where its line starts and makes the total follow the narration", () => {
    const r = ok(retimeScene3d(eight(), { beats, words: words(), narrationDurationS: 28.5 }));
    const d = r.scene.shots.map((s) => s.duration_s);
    expect(r.totalS).toBeGreaterThan(27);
    expect(r.totalS).toBeLessThan(32);
    expect(shotsTotalS(r.scene.shots)).toBe(r.totalS);
    expect(d.every((x) => x >= 2 && x <= 12)).toBe(true);
    expect(r.scene.shots.map((s) => s.id)).toEqual(IDS);
  });
  it("clamps each shot to 2-12 s", () => {
    const slow = ok(retimeScene3d(eight(), { beats: [{ id: "hook", words: 1 }, ...beats.slice(1)], words: words(70, 0.7), narrationDurationS: 49.5 }));
    expect(Math.max(...slow.scene.shots.map((s) => s.duration_s))).toBeLessThanOrEqual(12);
    expect(Math.min(...slow.scene.shots.map((s) => s.duration_s))).toBeGreaterThanOrEqual(2);
  });
  it("splits a beat's time over its extra shots in proportion", () => {
    const sc = make([{ id: "hook", duration_s: 6 }, { id: "hook_2", duration_s: 2 }, ...IDS.slice(1).map((id) => ({ id, duration_s: 8 }))]);
    const r = ok(retimeScene3d(sc, { beats, words: words(), narrationDurationS: 28.5 }));
    const [a, b] = r.scene.shots;
    expect(a!.duration_s / b!.duration_s).toBeGreaterThan(1.5);
    expect(a!.duration_s / b!.duration_s).toBeLessThan(4.5);
  });
  it("moves animations with their shots and keeps them inside the new length", () => {
    const r = ok(retimeScene3d(eight(), { beats, words: words(), narrationDurationS: 28.5 }));
    const a = r.scene.elements.find((e) => e.id === "b")!.animations[0]!;
    expect(a.start_s + a.duration_s).toBeLessThanOrEqual(r.totalS + 0.001);
    expect(a.start_s).toBeLessThan(40);
  });
  it("loopBack false holds the picture a little longer at the end", () => {
    const loop = ok(retimeScene3d(eight(), { beats, words: words(), narrationDurationS: 28.5 }));
    const hold = ok(retimeScene3d(eight(), { beats, words: words(), narrationDurationS: 28.5, loopBack: false }));
    expect(hold.totalS).toBeGreaterThan(loop.totalS);
  });
  it("refuses with a reason when there are no word times, no beats, or the narration needs more than 60 s", () => {
    expect(retimeScene3d(eight(), { beats, words: [], narrationDurationS: 10 })).toEqual({ ok: false, reason: "no word times" });
    expect(retimeScene3d(eight(), { beats: [], words: words(), narrationDurationS: 10 }).ok).toBe(false);
    const long = retimeScene3d(eight(), { beats, words: words(70, 1.2), narrationDurationS: 85 });
    expect(!long.ok && long.reason).toMatch(/at most 60 s/);
  });
  it("does not change the scene it was given", () => {
    const sc = eight();
    const before = JSON.stringify(sc);
    ok(retimeScene3d(sc, { beats, words: words(), narrationDurationS: 28.5 }));
    expect(JSON.stringify(sc)).toBe(before);
  });
  it("shot ids map to beats by id or beat_2, longest beat id first", () => {
    expect(shotBeatId("hook_2", IDS)).toBe("hook");
    expect(shotBeatId("hookx", IDS)).toBeNull();
    expect(shotBeatId("a_b_2", ["a", "a_b"])).toBe("a_b");
  });
});
