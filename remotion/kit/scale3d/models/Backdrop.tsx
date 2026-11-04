import React, { useMemo } from "react";
import * as THREE from "three";
import { Built, C, type Merger } from "./geo";

/** The ground: a huge pastel plane that catches shadows and fades into the fog. */
export const Ground: React.FC<{ size: number }> = ({ size }) => (
  <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow>
    <planeGeometry args={[size, size]} />
    <meshStandardMaterial color={C.grass} roughness={1} />
  </mesh>
);

let blobTex: THREE.CanvasTexture | undefined;
const softBlob = (): THREE.CanvasTexture => {
  if (blobTex) return blobTex;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, "rgba(40,50,60,0.45)");
  grad.addColorStop(1, "rgba(40,50,60,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  blobTex = new THREE.CanvasTexture(c);
  return blobTex;
};

/** A soft dark patch on the ground under an object (cheap ambient occlusion), so nothing looks pasted on. */
export const ContactShadow: React.FC<{ w: number; d: number }> = ({ w, d }) => (
  <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]} renderOrder={1}>
    <planeGeometry args={[w * 1.5, d * 1.5]} />
    <meshBasicMaterial map={softBlob()} transparent depthWrite={false} />
  </mesh>
);

const car = (m: Merger, x: number, z: number, color: string, rot = 0) => {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const p = (dx: number, dz: number): [number, number] => [x + dx * c - dz * s, z + dx * s + dz * c];
  const [bx, bz] = p(0, 0);
  m.box(bx, 0.55, bz, 4.4, 0.7, 1.8, color, -rot);
  const [cx, cz] = p(-0.2, 0);
  m.box(cx, 1.15, cz, 2.3, 0.6, 1.62, C.glass, -rot);
  for (const dx of [-1.4, 1.4]) for (const dz of [-0.9, 0.9]) {
    const [wx, wz] = p(dx, dz);
    m.cyl(wx, 0.05, wz, 0.38, 0.38, 0.3, C.black, 8);
  }
};
const lamp = (m: Merger, x: number, z: number, face: number) => {
  m.cyl(x, 0, z, 0.09, 0.13, 6.2, C.dark, 6);
  m.box(x + face * 0.7, 6.2, z, 1.5, 0.1, 0.1, C.dark);
  m.blob(x + face * 1.4, 6.05, z, 0.34, 0.16, 0.22, "#fff3c9");
};
const bench = (m: Merger, x: number, z: number) => {
  m.box(x, 0.5, z, 1.8, 0.1, 0.5, C.trunk);
  m.box(x, 0.85, z - 0.22, 1.8, 0.45, 0.08, C.trunk);
  for (const dx of [-0.75, 0.75]) m.box(x + dx, 0.25, z, 0.1, 0.5, 0.45, C.dark);
};
const hydrant = (m: Merger, x: number, z: number) => {
  m.cyl(x, 0, z, 0.16, 0.18, 0.7, C.red, 7);
  m.blob(x, 0.75, z, 0.18, 0.12, 0.18, C.red);
};

/** Street furniture at real size along the front of an object: lamps, benches, parked cars, hydrants, bushes. Skipped for huge things. */
export const Surroundings: React.FC<{ width: number; depth: number; height: number }> = ({ width, depth, height }) => {
  const n = useMemo(() => Math.min(8, Math.max(1, Math.round(width / 16))), [width]);
  if (height > 150 || width < 3) return null;
  const front = depth / 2 + 4;
  const colors = [C.roofBlue, C.roofRed, C.steel, C.leaf1];
  return (
    <Built
      deps={[width, depth, height, n]}
      cast
      build={(m) => {
        // road strip along the front, with a dashed centre line
        m.block(0, 0, front + 5, width * 1.5 + 12, 0.05, 9, C.road);
        for (let i = -n * 2; i <= n * 2; i++) m.block((i * width * 0.7) / (n * 2), 0.05, front + 5, 1.6, 0.02, 0.2, C.white);
        // pavement edge
        m.block(0, 0, front - 0.2, width * 1.5 + 12, 0.18, 2.2, C.concrete);
        for (let i = 0; i < n; i++) {
          const x = -width * 0.6 + (i / Math.max(1, n - 1)) * width * 1.2 * (n > 1 ? 1 : 0.5);
          lamp(m, x, front - 0.3, i % 2 ? 1 : -1);
          if (i % 2 === 0) car(m, x + 5, front + 7.6, colors[i % colors.length]!, 0);
          else bench(m, x + 3, front + 0.2);
          if (i % 3 === 0) hydrant(m, x - 3, front + 0.3);
          m.blob(x - 6, 0.5, front - 1.4, 1.1, 0.6, 0.9, C.leaf3, 1);
        }
      }}
    />
  );
};

/** A few flat, soft clouds well above the scene. */
export const Clouds: React.FC<{ reach: number }> = ({ reach }) => (
  <Built
    deps={[reach]}
    cast={false}
    receive={false}
    build={(m) => {
      for (let i = 0; i < 14; i++) {
        const a = i * 2.399;
        const r = reach * (0.5 + 0.9 * ((i * 0.37) % 1));
        const x = Math.cos(a) * r;
        const z = -Math.abs(Math.sin(a)) * r - reach * 0.4;
        const y = reach * (0.28 + 0.2 * ((i * 0.61) % 1));
        const s = reach * (0.06 + 0.05 * ((i * 0.53) % 1));
        for (let k = 0; k < 4; k++) m.blob(x + (k - 1.5) * s * 0.9, y + (k % 2) * s * 0.15, z, s, s * 0.45, s * 0.6, "#ffffff", 1);
      }
    }}
  />
);
