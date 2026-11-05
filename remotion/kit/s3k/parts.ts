// Small mesh builders (the proof's k.ts): standard materials with the house look, boxes, cylinders, struts and ring sectors.
// All meshes cast and receive shadows. Positions are metres, y up.
import * as THREE from "three";

/** Environment light level on every material made here (the sky bake is bright; half keeps shapes readable). */
export const ENV_K = 0.5;

export function std(color: string | number, o: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.1, envMapIntensity: ENV_K, ...o });
}
/** Painted steel: metalness .55, rough .38 by default. */
export const steel = (c: string | number, rough = 0.38): THREE.MeshStandardMaterial => std(c, { metalness: 0.55, roughness: rough });
/** Lamp panel that glows (emissive) so bloom picks it up. */
export const glow = (c: string, k = 2.4): THREE.MeshStandardMaterial => std("#ffffff", { emissive: new THREE.Color(c), emissiveIntensity: k });

/** Turns shadows on (or off) for a whole object tree. */
export function shadowize<T extends THREE.Object3D>(o: T, cast = true, recv = true): T {
  o.traverse((c) => { if ((c as THREE.Mesh).isMesh) { c.castShadow = cast; c.receiveShadow = recv; } });
  return o;
}

/** Box w x h x d centred at x,y,z. */
export function box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, parent?: THREE.Object3D): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = m.receiveShadow = true;
  parent?.add(m);
  return m;
}
/** Cylinder (radius top/bottom, length) lying along axis 'x' | 'y' | 'z', centred at x,y,z. */
export function cyl(rt: number, rb: number, len: number, mat: THREE.Material, axis: "x" | "y" | "z", x: number, y: number, z: number, parent?: THREE.Object3D, seg = 28): THREE.Mesh {
  const g = new THREE.CylinderGeometry(rt, rb, len, seg);
  if (axis === "x") g.rotateZ(Math.PI / 2); else if (axis === "z") g.rotateX(Math.PI / 2);
  const m = new THREE.Mesh(g, mat);
  m.position.set(x, y, z);
  m.castShadow = m.receiveShadow = true;
  parent?.add(m);
  return m;
}
const UP = new THREE.Vector3(0, 1, 0);
/** Round strut of radius r from point a to point b (pipes, braces, rails on a slope). */
export function between(a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material, parent?: THREE.Object3D, seg = 14): THREE.Mesh {
  const d = b.clone().sub(a);
  const len = d.length();
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, seg), mat);
  m.position.copy(a).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(UP, d.normalize());
  m.castShadow = m.receiveShadow = true;
  parent?.add(m);
  return m;
}
/** Sector of a ring around the x axis (a tunnel wall, a half pipe): outer/inner radius, angles a0..a1 in radians in the y/z plane, length along +x. */
export function sector(rO: number, rI: number, a0: number, a1: number, len: number): THREE.ExtrudeGeometry {
  const s = new THREE.Shape();
  s.moveTo(rO * Math.cos(a0), rO * Math.sin(a0));
  s.absarc(0, 0, rO, a0, a1, false);
  s.lineTo(rI * Math.cos(a1), rI * Math.sin(a1));
  s.absarc(0, 0, rI, a1, a0, true);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: len, bevelEnabled: false, curveSegments: Math.max(3, Math.round((a1 - a0) * 8)) });
  g.rotateY(Math.PI / 2); // local z -> +x, local x -> -z
  return g;
}
/** Full ring (annulus) around the x axis, outer radius rO, inner rI, length len. */
export function ring(rO: number, rI: number, len: number): THREE.ExtrudeGeometry {
  const s = new THREE.Shape();
  s.absarc(0, 0, rO, 0, Math.PI * 2, false);
  const h = new THREE.Path();
  h.absarc(0, 0, rI, 0, Math.PI * 2, true);
  s.holes.push(h);
  const g = new THREE.ExtrudeGeometry(s, { depth: len, bevelEnabled: false, curveSegments: 40 });
  g.rotateY(Math.PI / 2);
  return g;
}
