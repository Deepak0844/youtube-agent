// Procedural ship / barge: lofted rounded hull (pointed bow, flat stern, red below the waterline stripe, white topsides), open cargo hold
// with sand heap and red coaming, bridge with windows, red funnel, yellow cargo arch and a nozzle boom. Local frame: bow towards +x,
// deck at y = 2.6, waterline at y = 0.2. Drawn for a 26 m ship and scaled to length_m.
import React, { useMemo } from "react";
import * as THREE from "three";
import type { ElOf } from "../ctx";
import { useBlock } from "../ctx";
import { rng, surfaceTile } from "../textures";

const DESIGN_L = 26;
const STERN = -12;
const BOW = 13;
const BEAM = 6.4;
const KEEL = -1.9;
const DECK = 2.6;
const WL = 0.5; // red/white split

/** Half-width fraction along the hull (0 stern .. 1 bow): full beam through the middle, rounded stern corners, long pointed bow. */
const halfBeam = (s: number): number => {
  if (s < 0.06) return 0.86 + 0.14 * Math.sqrt(s / 0.06) * 0.0 + 0.14 * (s / 0.06);
  if (s < 0.66) return 1;
  const u = (s - 0.66) / 0.34;
  return Math.max(0, Math.pow(1 - u * u, 0.62));
};

/** Lofted hull: sections along x, each a rounded U (superellipse) from keel to deck, with a bit of sheer and bow rake. */
export function hullGeometry(): THREE.BufferGeometry {
  const S = 44;
  const M = 28;
  const pos: number[] = [];
  const col: number[] = [];
  const red = new THREE.Color("#ffffff");
  const idx: number[] = [];
  for (let i = 0; i <= S; i++) {
    const s = i / S;
    const x = STERN + s * (BOW - STERN);
    const hb = (BEAM / 2) * halfBeam(s);
    const sheer = DECK + 0.45 * Math.pow(s, 3) - 0.15 * Math.sin(s * Math.PI);
    const keel = KEEL + 1.5 * Math.pow(Math.max(0, s - 0.7) / 0.3, 2) + 0.25 * Math.max(0, 0.1 - s) / 0.1;
    for (let j = 0; j <= M; j++) {
      // angle from the port deck edge around the bottom to the starboard deck edge
      const a = (j / M) * Math.PI;
      const sx = Math.cos(a);
      const sy = Math.sin(a);
      const e = 3.2;
      const px = Math.sign(sx) * Math.pow(Math.abs(sx), 2 / e);
      const py = Math.pow(sy, 2 / e);
      const y = sheer - (sheer - keel) * py;
      pos.push(x, y, -px * hb);
      const tone = y > WL ? 1 : 0;
      col.push(tone, tone, tone);
      red.setRGB(tone, tone, tone);
    }
  }
  for (let i = 0; i < S; i++) for (let j = 0; j < M; j++) {
    const a = i * (M + 1) + j;
    const b = a + 1;
    const c = a + M + 1;
    idx.push(a, b, c, b, c + 1, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const WHITE = "#f4f2ed";
const Std: React.FC<{ c: string; r?: number; m?: number }> = ({ c, r = 0.5, m = 0 }) => <meshStandardMaterial color={c} roughness={r} metalness={m} />;

export const Ship: React.FC<{ el: ElOf<"ship"> }> = ({ el }) => {
  const { t } = useBlock();
  const k = el.length_m / DESIGN_L;
  const hullGeo = useMemo(() => hullGeometry(), []);
  const hullMat = useMemo(() => {
    // vertex colour 1 = white topsides, 0 = hull colour below the stripe
    const m = new THREE.MeshStandardMaterial({ vertexColors: false, roughness: 0.42, metalness: 0.02, side: THREE.DoubleSide });
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uLow = { value: new THREE.Color(el.hull_color) };
      sh.uniforms.uTop = { value: new THREE.Color(WHITE) };
      sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nattribute vec3 color; varying float vTone;").replace("#include <begin_vertex>", "#include <begin_vertex>\nvTone = color.r;");
      sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nvarying float vTone; uniform vec3 uLow, uTop;").replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.rgb = mix(uLow, uTop, smoothstep(0.35, 0.65, vTone));");
    };
    return m;
  }, [el.hull_color]);
  const sand = useMemo(() => surfaceTile("sand", "#e7d1a0").texture, []);
  const heap = useMemo(() => {
    const g = new THREE.IcosahedronGeometry(1, 3);
    const p = g.attributes.position as THREE.BufferAttribute;
    const r = rng(8);
    for (let i = 0; i < p.count; i++) { const f = 1 + (r() - 0.5) * 0.05 + Math.sin(p.getX(i) * 7 + p.getZ(i) * 5) * 0.04; p.setXYZ(i, p.getX(i) * f, Math.max(p.getY(i), -0.1) * f, p.getZ(i) * f); }
    g.computeVertexNormals();
    return g;
  }, []);
  const deck = useMemo(() => {
    // flat deck with a rectangular hold cut out
    const s = new THREE.Shape();
    const N = 30;
    s.moveTo(STERN, (BEAM / 2) * halfBeam(0) * 0.97);
    for (let i = 1; i <= N; i++) { const q = i / N; s.lineTo(STERN + q * (BOW - STERN), (BEAM / 2) * halfBeam(q) * 0.97); }
    for (let i = N; i >= 0; i--) { const q = i / N; s.lineTo(STERN + q * (BOW - STERN), -(BEAM / 2) * halfBeam(q) * 0.97); }
    const hole = new THREE.Path();
    hole.moveTo(-3.2, -2.4); hole.lineTo(8.2, -2.4); hole.lineTo(8.2, 2.4); hole.lineTo(-3.2, 2.4); hole.closePath();
    s.holes.push(hole);
    const g = new THREE.ShapeGeometry(s, 4);
    g.rotateX(-Math.PI / 2);
    g.translate(0, DECK, 0);
    return g;
  }, []);
  const bob = Math.sin(t * 1.6) * 0.12;
  const roll = Math.sin(t * 1.1) * 0.012;
  const pitch = Math.sin(t * 0.9 + 1) * 0.006;
  const hold = el.cargo === "sand";
  return (
    <group scale={k} position={[0, bob * k, 0]} rotation={[roll, 0, pitch]}>
      <mesh geometry={hullGeo} material={hullMat} castShadow receiveShadow />
      <mesh geometry={deck} castShadow receiveShadow><meshStandardMaterial color="#b9b4aa" roughness={0.8} side={THREE.DoubleSide} /></mesh>
      {/* open hold: inner walls and floor, sand heap, red coaming */}
      <mesh position={[2.5, 1.7, 0]} receiveShadow><boxGeometry args={[11.4, 0.1, 4.8]} /><meshStandardMaterial color="#6b5f52" roughness={1} /></mesh>
      {hold ? <mesh position={[2.5, 1.75, 0]} scale={[5.4, 1.7, 2.2]} castShadow receiveShadow geometry={heap}><meshStandardMaterial map={sand} roughness={1} /></mesh> : null}
      {([[2.5, 2.9, 2.5, 11.8, 0.55, 0.28], [2.5, 2.9, -2.5, 11.8, 0.55, 0.28], [-3.2, 2.9, 0, 0.28, 0.55, 5.3], [8.2, 2.9, 0, 0.28, 0.55, 5.3]] as const).map(([x, y, z, w, h, d], i) => (
        <mesh key={i} position={[x, y, z]} castShadow receiveShadow><boxGeometry args={[w, h, d]} /><Std c="#d23a2b" r={0.45} /></mesh>
      ))}
      <mesh position={[2.5, 2.65, 2.78]}><boxGeometry args={[11.8, 0.12, 0.2]} /><Std c="#f4f2ed" /></mesh>
      <mesh position={[2.5, 2.65, -2.78]}><boxGeometry args={[11.8, 0.12, 0.2]} /><Std c="#f4f2ed" /></mesh>
      {/* yellow cargo arch */}
      {[2.9, -2.9].map((z, i) => <mesh key={i} position={[9.2, 4.7, z]} castShadow><boxGeometry args={[0.28, 4.4, 0.28]} /><Std c="#e8c02b" /></mesh>)}
      <mesh position={[9.2, 6.9, 0]} castShadow><boxGeometry args={[0.28, 0.28, 6.0]} /><Std c="#e8c02b" /></mesh>
      {/* bridge, windows, funnel, mast */}
      <mesh position={[-7.6, 4.9, 0]} castShadow receiveShadow><boxGeometry args={[4.4, 4.6, 5.4]} /><Std c={WHITE} r={0.45} /></mesh>
      <mesh position={[-7.6, 7.7, 0]} castShadow><boxGeometry args={[3.4, 1.3, 4.9]} /><Std c={WHITE} r={0.45} /></mesh>
      <mesh position={[-7.6, 8.4, 0]} castShadow><boxGeometry args={[3.7, 0.18, 5.2]} /><Std c="#d23a2b" /></mesh>
      <mesh position={[-5.38, 7.75, 0]}><boxGeometry args={[0.06, 0.85, 4.5]} /><Std c="#27425b" r={0.15} m={0.2} /></mesh>
      <mesh position={[-5.38, 5.3, 0]}><boxGeometry args={[0.06, 0.8, 4.7]} /><Std c="#27425b" r={0.15} m={0.2} /></mesh>
      <mesh position={[-7.6, 5.3, 2.72]}><boxGeometry args={[3.4, 0.8, 0.06]} /><Std c="#27425b" r={0.15} m={0.2} /></mesh>
      <mesh position={[-7.6, 5.3, -2.72]}><boxGeometry args={[3.4, 0.8, 0.06]} /><Std c="#27425b" r={0.15} m={0.2} /></mesh>
      <mesh position={[-9.9, 8.7, 0]} castShadow><cylinderGeometry args={[0.75, 0.85, 2.6, 24]} /><Std c="#d23a2b" /></mesh>
      <mesh position={[-9.9, 10.1, 0]}><cylinderGeometry args={[0.78, 0.78, 0.3, 24]} /><Std c="#25272b" /></mesh>
      <mesh position={[-7.6, 9.5, 0]}><cylinderGeometry args={[0.05, 0.05, 2.2, 6]} /><Std c="#444" /></mesh>
      {/* nozzle boom over the bow: root on the deck, rising out past the bow */}
      <mesh position={[11.6, 4.6, 0]} rotation={[0, 0, -0.85]} castShadow><cylinderGeometry args={[0.42, 0.55, 5.8, 20]} /><Std c="#33363b" /></mesh>
      <mesh position={[13.8, 6.5, 0]} rotation={[0, 0, -0.85]}><cylinderGeometry args={[0.6, 0.45, 0.5, 20]} /><Std c="#1f2124" /></mesh>
      {/* rails */}
      {[-1, 1].map((sd) => <mesh key={sd} position={[-1, 3.15, sd * 3.0]}><boxGeometry args={[18, 0.07, 0.07]} /><Std c="#e9e5dc" /></mesh>)}
    </group>
  );
};
