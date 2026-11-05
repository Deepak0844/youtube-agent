import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { buildCutFace } from "../../remotion/kit/s3k/Cutaway";
import { fitScale } from "../../remotion/kit/s3k/fit";
import { gridSlots, instance, ringSlots, rowSlots } from "../../remotion/kit/s3k/instancing";
import { captionPhase } from "../../remotion/kit/s3k/Overlays";
import { particleSeeds, phaseOf } from "../../remotion/kit/s3k/particles";
import { clamp, ramp, rnd, smooth } from "../../remotion/kit/s3k/rng";
import { layerEdges, STRATA_DEFAULT } from "../../remotion/kit/s3k/textures";
import { rest } from "../../remotion/kit/s3k/rest";
import { ringStarts } from "../../remotion/kit/s3k/examples/lining";
import { ST0, ST1, XMIN } from "../../remotion/kit/s3k/examples/dims";

describe("instancing slots", () => {
  it("rowSlots steps evenly", () => {
    const s = rowSlots(4, [0, 1, 2], [-1.5, 0, 0.5]);
    expect(s).toHaveLength(4);
    expect(s[3]).toEqual({ x: -4.5, y: 1, z: 3.5 });
    expect(rowSlots(0, [0, 0, 0], [1, 0, 0])).toEqual([]);
  });
  it("ringSlots puts every slot on the circle in the plane perpendicular to the axis", () => {
    for (const axis of ["x", "y", "z"] as const) {
      const c: [number, number, number] = [1, 2, 3];
      const s = ringSlots(12, 4, axis, c);
      expect(s).toHaveLength(12);
      for (const p of s) {
        const d = [p.x - c[0], p.y - c[1], p.z - c[2]];
        const along = axis === "x" ? d[0]! : axis === "y" ? d[1]! : d[2]!;
        expect(along).toBeCloseTo(0, 9);
        expect(Math.hypot(...d)).toBeCloseTo(4, 9);
      }
    }
  });
  it("gridSlots is centred with the right count and spacing", () => {
    const s = gridSlots(3, 2, 2, 5, [10, 20, 30]);
    expect(s).toHaveLength(6);
    expect(s.map((p) => p.x)).toEqual([8, 10, 12, 8, 10, 12]);
    expect(s.map((p) => p.y)).toEqual([17.5, 17.5, 17.5, 22.5, 22.5, 22.5]);
    expect(s.every((p) => p.z === 30)).toBe(true);
  });
  it("instance writes one matrix per slot", () => {
    const im = instance(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), rowSlots(3, [0, 0, 0], [2, 0, 0]));
    expect(im.count).toBe(3);
    const m = new THREE.Matrix4(); im.getMatrixAt(2, m);
    expect(new THREE.Vector3().setFromMatrixPosition(m).x).toBe(4);
  });
});

describe("particles and time helpers are pure", () => {
  it("seeds are identical for the same seed and in range", () => {
    expect(particleSeeds(50, 3)).toEqual(particleSeeds(50, 3));
    for (const s of particleSeeds(50, 3)) { expect(s.p).toBeGreaterThanOrEqual(0); expect(s.p).toBeLessThan(1); expect(s.sp).toBeGreaterThanOrEqual(0.12); expect(s.sp).toBeLessThan(0.42); }
  });
  it("phase is a pure function of t, always in [0, 1), and loops", () => {
    const s = { p: 0.3, sp: 0.25 };
    for (let t = -5; t < 20; t += 0.37) { const ph = phaseOf(t, s); expect(ph).toBeGreaterThanOrEqual(0); expect(ph).toBeLessThan(1); expect(phaseOf(t, s)).toBe(ph); }
    expect(phaseOf(0, s)).toBeCloseTo(phaseOf(4, s), 9); // period 1 / 0.25 = 4 s
  });
  it("rnd repeats; ramp, clamp and smooth behave at the edges", () => {
    const a = rnd(7), b = rnd(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(ramp(3, 4, 6)).toBe(0); expect(ramp(5, 4, 6)).toBe(0.5); expect(ramp(9, 4, 6)).toBe(1);
    expect(clamp(5, 0, 1)).toBe(1); expect(smooth(0)).toBe(0); expect(smooth(1)).toBe(1); expect(smooth(0.5)).toBeCloseTo(0.5, 9);
  });
  it("captions ease in and out inside their window and are off outside it", () => {
    expect(captionPhase(0.9, 1, 3).active).toBe(false);
    expect(captionPhase(1, 1, 3).alpha).toBe(0);
    expect(captionPhase(2, 1, 3).alpha).toBe(1);
    expect(captionPhase(2.99, 1, 3).alpha).toBeLessThan(0.2);
    expect(captionPhase(3, 1, 3).active).toBe(false);
  });
});

describe("models, layers, cut face", () => {
  it("fitScale scales the longest side, or the height, or uses the catalogue default", () => {
    const dims = { x: 2, y: 8, z: 4 };
    expect(fitScale(dims, { size: 4 })).toBe(0.5);
    expect(fitScale({ x: 10, y: 2, z: 4 }, { size: 5, height: true })).toBe(2.5);
    expect(fitScale(dims, { info: { default_scale: 3 } })).toBe(3);
    expect(fitScale(dims, {})).toBe(1);
  });
  it("layerEdges are increasing and end at 1", () => {
    const e = layerEdges(STRATA_DEFAULT);
    expect(e).toHaveLength(STRATA_DEFAULT.length);
    for (let i = 1; i < e.length; i++) expect(e[i]!).toBeGreaterThan(e[i - 1]!);
    expect(e[e.length - 1]).toBeCloseTo(1, 9);
  });
  it("the cut face has the hole punched out: no triangle covers its middle", () => {
    const hole: [number, number][] = [[-10, -10], [10, -10], [10, -4], [-10, -4]];
    const g = buildCutFace({ x0: -50, x1: 50, bottom: -30, holes: [hole] });
    const pos = g.attributes.position as THREE.BufferAttribute;
    const idx = g.index!;
    const P = (i: number) => new THREE.Vector2(pos.getX(i), pos.getY(i));
    let area = 0;
    for (let k = 0; k < idx.count; k += 3) {
      const a = P(idx.getX(k)), b = P(idx.getX(k + 1)), c = P(idx.getX(k + 2));
      area += Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
      const mid = a.clone().add(b).add(c).divideScalar(3);
      expect(mid.x > -10 && mid.x < 10 && mid.y > -10 && mid.y < -4, "a triangle centre lies inside the hole").toBe(false);
    }
    expect(area).toBeCloseTo(100 * 30 - 20 * 6, 3);
  });
  it("rest puts the lowest point on the plane", () => {
    const parent = new THREE.Group();
    const m = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 2));
    m.position.set(3, 17, 1); parent.add(m);
    rest(m, 0.5, 0.1);
    expect(new THREE.Box3().setFromObject(m).min.y).toBeCloseTo(0.6, 9);
    rest(m, (x) => x * 2); // ground that rises with x: under the centre x = 3 the ground is at 6
    expect(new THREE.Box3().setFromObject(m).min.y).toBeCloseTo(6, 9);
  });
  it("lining rings skip the station box and stop at the far end", () => {
    const xs = ringStarts();
    expect(xs.length).toBeGreaterThan(50);
    for (const x of xs) { expect(x).toBeGreaterThanOrEqual(XMIN); expect(x + 1.5 > ST0 - 0.01 && x < ST1).toBe(false); }
  });
});
