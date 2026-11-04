// RockPile / Boulders: chunky displaced rocks drawn as instances (one draw call per rock shape). A pile is a heap; a ring is a sand wall
// with a boulder crest (the revetment around a reclamation basin), with eroded streaks down its inner face and tapered ends.
import React, { useMemo } from "react";
import * as THREE from "three";
import type { ElOf } from "../ctx";
import { RING_PROFILE, ringHeightFrac } from "../field";
import { rng } from "../textures";

const smooth = (u: number) => { const x = Math.min(1, Math.max(0, u)); return x * x * (3 - 2 * x); };

/** A faceted rock: icosphere pushed in and out by layered noise, flattened a little, base roughly flat. */
export function rockGeometry(seed: number, detail = 1): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const r = rng(seed);
  const ph = [r() * 6, r() * 6, r() * 6, r() * 6];
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const n = 1 + 0.22 * Math.sin(x * 2.3 + ph[0]!) * Math.cos(z * 2.1 + ph[1]!) + 0.16 * Math.sin(y * 3.1 + x * 1.7 + ph[2]!) + 0.08 * Math.sin((x + y + z) * 5 + ph[3]!);
    p.setXYZ(i, x * n, Math.max(y * n * 0.72, -0.45), z * n * 0.9);
  }
  g.computeVertexNormals();
  return g;
}

type RockSpot = { p: THREE.Vector3; s: number; q: THREE.Quaternion; c: THREE.Color; sy: number };

const RockInstances: React.FC<{ spots: RockSpot[]; seed: number }> = ({ spots, seed }) => {
  const meshes = useMemo(() => {
    const geos = [0, 1, 2].map((k) => rockGeometry(seed * 7 + k * 31 + 1));
    const mat = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.88, flatShading: true });
    const groups = geos.map(() => [] as RockSpot[]);
    spots.forEach((s, i) => groups[i % 3]!.push(s));
    const m4 = new THREE.Matrix4();
    return geos.map((g, k) => {
      const im = new THREE.InstancedMesh(g, mat, Math.max(1, groups[k]!.length));
      groups[k]!.forEach((s, i) => {
        m4.compose(s.p, s.q, new THREE.Vector3(s.s, s.s * s.sy, s.s));
        im.setMatrixAt(i, m4);
        im.setColorAt(i, s.c);
      });
      im.count = groups[k]!.length;
      im.castShadow = true;
      im.receiveShadow = true;
      im.frustumCulled = false;
      return im;
    });
  }, [spots, seed]);
  return <>{meshes.map((m, i) => <primitive key={i} object={m} />)}</>;
};

const rockColour = (r: () => number) => new THREE.Color().setHSL(0.085 + r() * 0.04, 0.06 + r() * 0.1, 0.26 + r() * 0.2);
const yaw = (r: () => number) => new THREE.Quaternion().setFromEuler(new THREE.Euler(r() * 6.28, r() * 6.28, r() * 6.28));

export const RockPile: React.FC<{ el: ElOf<"rock_pile"> }> = ({ el }) => {
  const { geo, spots } = useMemo(() => {
    const r = rng(el.seed * 101 + 3);
    const spots: RockSpot[] = [];
    let geo: THREE.BufferGeometry | null = null;
    if (el.shape === "pile") {
      for (let i = 0; i < el.count; i++) {
        const rr = Math.sqrt(r()) * el.radius_m;
        const a = r() * Math.PI * 2;
        const top = el.height_m * (1 - smooth(rr / el.radius_m)) * 0.8;
        const s = Math.max(0.25, el.height_m * (0.18 + r() * 0.5)) * (1 - 0.5 * rr / el.radius_m);
        spots.push({ p: new THREE.Vector3(Math.cos(a) * rr, top * 0.6 + s * 0.15, Math.sin(a) * rr), s, q: yaw(r), c: rockColour(r), sy: 0.8 });
      }
      return { geo, spots };
    }
    // ring: wall mesh from the profile, then boulders along the crest and outer slope
    const [a0, a1] = el.arc_deg.map((d) => (d * Math.PI) / 180) as [number, number];
    const N = Math.max(48, Math.round(((a1 - a0) * el.radius_m) / 1.6));
    const K = RING_PROFILE.length;
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const cs = new THREE.Color("#e8d6ac");
    const cd = new THREE.Color("#b9a68a");
    const c = new THREE.Color();
    const jit = Array.from({ length: N + 1 }, () => r());
    for (let i = 0; i <= N; i++) {
      const phi = a0 + (a1 - a0) * (i / N);
      const taper = Math.min(1, Math.min(i, N - i) / 10);
      const streak = 0.9 + 0.1 * Math.sin(i * 1.9) + 0.06 * (jit[i]! - 0.5);
      RING_PROFILE.forEach(([off, hf, mix], k) => {
        const rr = el.radius_m + off * el.width_m;
        const yy = hf * el.height_m * (k === 0 || k === K - 1 ? 1 : 0.3 + 0.7 * taper) * (hf > 0 ? 1 : 1) + (hf > 0 && hf < 1 ? (jit[i]! - 0.5) * 0.4 : 0);
        pos.push(Math.cos(phi) * rr, hf === 0 ? 0 : yy, -Math.sin(phi) * rr);
        c.copy(cs).lerp(cd, mix * 0.9).multiplyScalar(streak * (k < 3 ? 0.94 + 0.1 * ((i % 3) / 2) : 0.9 + 0.2 * jit[i]!));
        col.push(c.r, c.g, c.b);
      });
    }
    for (let i = 0; i < N; i++) for (let k = 0; k < K - 1; k++) {
      const a = i * K + k;
      const b = a + 1;
      const cc = (i + 1) * K + k;
      idx.push(a, cc, b, b, cc, cc + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    geo = g;
    for (let i = 0; i < el.count; i++) {
      const phi = a0 + (a1 - a0) * r();
      const off = -0.3 + r() * 0.85;
      const taper = Math.min(1, Math.min(phi - a0, a1 - phi) / 0.18);
      const hf = ringHeightFrac(off);
      const s = (0.12 + r() * 0.26) * el.width_m * (0.5 + 0.5 * taper);
      const rr = el.radius_m + off * el.width_m;
      spots.push({ p: new THREE.Vector3(Math.cos(phi) * rr, hf * el.height_m * (0.35 + 0.65 * taper) + s * 0.18, -Math.sin(phi) * rr), s, q: yaw(r), c: rockColour(r), sy: 0.8 });
    }
    return { geo, spots };
  }, [el]);
  return (
    <group>
      {geo ? <mesh geometry={geo} castShadow receiveShadow frustumCulled={false}><meshStandardMaterial vertexColors roughness={1} flatShading side={THREE.DoubleSide} /></mesh> : null}
      <RockInstances spots={spots} seed={el.seed} />
    </group>
  );
};
