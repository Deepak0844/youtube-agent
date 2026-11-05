// Instancing helpers: one draw call for hundreds of copies (rings of a tunnel, windows of a tower, sleepers of a track, stones on a belt).
// The slot functions are pure (numbers in, numbers out) so they can be tested; `instance` turns slots into an InstancedMesh.
import * as THREE from "three";

export type Slot = { x: number; y: number; z: number; rx?: number; ry?: number; rz?: number; s?: number };

/** `count` slots in a straight row from `start`, `step` apart (step is a vector, e.g. [-1.5, 0, 0] along -x). */
export function rowSlots(count: number, start: [number, number, number], step: [number, number, number]): Slot[] {
  return Array.from({ length: Math.max(0, count) }, (_, i) => ({ x: start[0] + step[0] * i, y: start[1] + step[1] * i, z: start[2] + step[2] * i }));
}
/** `count` slots on a circle of `radius` in the plane perpendicular to `axis` ('x' | 'y' | 'z'), centred on `c`; each turned to face outward (rotation about the axis). */
export function ringSlots(count: number, radius: number, axis: "x" | "y" | "z" = "x", c: [number, number, number] = [0, 0, 0], startDeg = 0): Slot[] {
  return Array.from({ length: Math.max(0, count) }, (_, i) => {
    const a = (startDeg * Math.PI) / 180 + (i / Math.max(1, count)) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
    if (axis === "x") return { x: c[0], y: c[1] + sa * radius, z: c[2] + ca * radius, rx: a };
    if (axis === "y") return { x: c[0] + ca * radius, y: c[1], z: c[2] + sa * radius, ry: -a };
    return { x: c[0] + ca * radius, y: c[1] + sa * radius, z: c[2], rz: a };
  });
}
/** A cols x rows grid on the plane facing `axis` (the wall's normal: 'z' = a wall facing +z), cells `dx` by `dy` apart, centred on `c`: windows on a facade. */
export function gridSlots(cols: number, rows: number, dx: number, dy: number, c: [number, number, number] = [0, 0, 0], axis: "z" | "x" = "z"): Slot[] {
  const out: Slot[] = [];
  for (let r = 0; r < rows; r++) for (let k = 0; k < cols; k++) {
    const u = (k - (cols - 1) / 2) * dx, v = (r - (rows - 1) / 2) * dy;
    out.push(axis === "z" ? { x: c[0] + u, y: c[1] + v, z: c[2] } : { x: c[0], y: c[1] + v, z: c[2] + u, ry: Math.PI / 2 });
  }
  return out;
}

const tmp = new THREE.Object3D();
/** Writes slots into an InstancedMesh (matrices). Call again with new slots to move them (then it flags the update). */
export function placeSlots(im: THREE.InstancedMesh, slots: readonly Slot[]): void {
  slots.forEach((s, i) => {
    tmp.position.set(s.x, s.y, s.z); tmp.rotation.set(s.rx ?? 0, s.ry ?? 0, s.rz ?? 0); tmp.scale.setScalar(s.s ?? 1);
    tmp.updateMatrix(); im.setMatrixAt(i, tmp.matrix);
  });
  im.instanceMatrix.needsUpdate = true;
}
/** An InstancedMesh with one copy of `geo` per slot. `tint(i)` gives a per-copy colour (concrete rings that are not all identical). */
export function instance(geo: THREE.BufferGeometry, mat: THREE.Material, slots: readonly Slot[], o: { tint?: (i: number) => THREE.ColorRepresentation; shadows?: boolean } = {}): THREE.InstancedMesh {
  const im = new THREE.InstancedMesh(geo, mat, slots.length);
  placeSlots(im, slots);
  if (o.tint) { const c = new THREE.Color(); slots.forEach((_, i) => { c.set(o.tint!(i)); im.setColorAt(i, c); }); }
  im.castShadow = im.receiveShadow = o.shadows ?? true;
  im.frustumCulled = false;
  return im;
}
