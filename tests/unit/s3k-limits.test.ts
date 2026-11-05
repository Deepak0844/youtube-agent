import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { safeModelUrl } from "../../remotion/kit/s3k/fit";
import { gridSlots, instance, ringSlots, rowSlots } from "../../remotion/kit/s3k/instancing";
import { between, cyl, segments, std } from "../../remotion/kit/s3k/parts";
import { particleSeeds } from "../../remotion/kit/s3k/particles";
import { capCount, MAX_COUNT } from "../../remotion/kit/s3k/rng";

// The kit bounds every count-like number a scene passes in (the static checker cannot): a hostile or careless scene gets a capped result.
describe("count clamps", () => {
  it("capCount: whole numbers from 0 to the cap; NaN and Infinity are 0", () => {
    expect(capCount(5.9)).toBe(5);
    expect(capCount(-3)).toBe(0);
    expect(capCount(NaN)).toBe(0);
    expect(capCount(Infinity)).toBe(0);
    expect(capCount(1e12)).toBe(MAX_COUNT);
    expect(capCount(1e12, 50)).toBe(50);
  });
  it("rowSlots, ringSlots, gridSlots and particleSeeds never make more than the cap", () => {
    expect(rowSlots(1e9, [0, 0, 0], [1, 0, 0])).toHaveLength(MAX_COUNT);
    expect(ringSlots(1e9, 5)).toHaveLength(MAX_COUNT);
    expect(gridSlots(1e9, 1e9, 1, 1).length).toBeLessThanOrEqual(MAX_COUNT);
    expect(gridSlots(1e9, 3, 1, 1).length).toBeLessThanOrEqual(MAX_COUNT);
    expect(particleSeeds(1e9)).toHaveLength(MAX_COUNT);
    expect(rowSlots(-5, [0, 0, 0], [1, 0, 0])).toHaveLength(0);
    expect(rowSlots(12, [0, 0, 0], [1, 0, 0])).toHaveLength(12);
    expect(gridSlots(4, 3, 1, 1)).toHaveLength(12);
  });
  it("instance keeps at most 50000 copies", () => {
    const slots = Array.from({ length: 50_010 }, (_, i) => ({ x: i, y: 0, z: 0 }));
    expect(instance(new THREE.BoxGeometry(1, 1, 1), std("#fff"), slots).count).toBe(50_000);
  });
  it("round parts use 3 to 64 segments whatever the scene asks for", () => {
    expect(segments(1e9)).toBe(64);
    expect(segments(0)).toBe(3);
    expect(segments(NaN)).toBe(12);
    const m = std("#fff");
    expect((cyl(1, 1, 1, m, "y", 0, 0, 0, undefined, 1e9).geometry as THREE.CylinderGeometry).parameters.radialSegments).toBe(64);
    expect((between(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0), 1, m, undefined, 1e9).geometry as THREE.CylinderGeometry).parameters.radialSegments).toBe(64);
  });
});

describe("safeModelUrl", () => {
  it("accepts only a relative staged .glb path", () => {
    for (const ok of ["models/pp_ship_cizo.glb", "/public/models/pp_ship.glb", "assets3d/files/pp_tree_qztx.glb", "public/models/a.b-c_d.glb"]) expect(safeModelUrl(ok), ok).toBe(true);
  });
  it("refuses every other address a resolver could return", () => {
    for (const bad of [
      "http://127.0.0.1:3000/x.glb", "https://evil.example/x.glb", "file:///etc/passwd.glb", "data:model/gltf-binary;base64,AAAA", "blob:http://localhost/x", "//evil.example/x.glb", "ws://127.0.0.1/x.glb",
      "../secret.glb", "models/../../x.glb", "models\\x.glb", "models/x.gltf", "models/x.glb?x=1", "models/x.glb#a", "models/ x.glb", "", "models/.glb", "javascript:alert(1).glb", "a".repeat(250) + ".glb",
    ]) expect(safeModelUrl(bad), bad).toBe(false);
    for (const nonString of [undefined, null, 5, {}, ["models/x.glb"]]) expect(safeModelUrl(nonString)).toBe(false);
  });
});
