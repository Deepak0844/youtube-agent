// Terrain patch: a flat plain, rolling hills or a single island, with a short skirt so its edge is not paper thin. Centred on its placement.
import React, { useMemo } from "react";
import * as THREE from "three";
import type { ElOf } from "../ctx";
import { surfaceTile } from "../textures";

const smooth = (u: number) => { const x = Math.min(1, Math.max(0, u)); return x * x * (3 - 2 * x); };

export const Terrain: React.FC<{ el: ElOf<"terrain"> }> = ({ el }) => {
  const [W, D] = el.size_m;
  const geo = useMemo(() => {
    const tile = surfaceTile(el.top).tileM;
    const nx = el.shape === "flat" ? 1 : Math.min(160, Math.max(24, Math.round(W / 6)));
    const nz = el.shape === "flat" ? 1 : Math.min(160, Math.max(24, Math.round(D / 6)));
    const height = (x: number, z: number): number => {
      if (el.shape === "flat") return el.height_m;
      if (el.shape === "island") return el.height_m * (1 - smooth(Math.hypot(x / (W / 2), z / (D / 2)))) ** 0.8;
      return el.height_m * (0.5 + 0.28 * Math.sin(x * 0.035) * Math.cos(z * 0.04) + 0.14 * Math.sin(x * 0.11 + z * 0.07) + 0.08 * Math.sin(z * 0.19));
    };
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
      const x = (i / nx - 0.5) * W;
      const z = (j / nz - 0.5) * D;
      pos.push(x, height(x, z), z);
      uv.push(x / tile, z / tile);
    }
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      idx.push(a, a + nx + 1, a + 1, a + 1, a + nx + 1, a + nx + 2);
    }
    // skirt: four walls dropping 14 m below the edge
    const base = pos.length / 3;
    const ring: [number, number][] = [];
    for (let i = 0; i <= nx; i++) ring.push([(i / nx - 0.5) * W, -D / 2]);
    for (let j = 1; j <= nz; j++) ring.push([W / 2, (j / nz - 0.5) * D]);
    for (let i = nx - 1; i >= 0; i--) ring.push([(i / nx - 0.5) * W, D / 2]);
    for (let j = nz - 1; j >= 1; j--) ring.push([-W / 2, (j / nz - 0.5) * D]);
    ring.forEach(([x, z], k) => { pos.push(x, height(x, z), z, x, -14, z); uv.push(k / 8, 0, k / 8, 2); });
    for (let k = 0; k < ring.length; k++) { const a = base + k * 2; const b = base + ((k + 1) % ring.length) * 2; idx.push(a, a + 1, b, b, a + 1, b + 1); }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }, [W, D, el.height_m, el.shape, el.top]);
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ map: surfaceTile(el.top).texture, roughness: 1, side: THREE.DoubleSide }), [el.top]);
  return <mesh geometry={geo} material={mat} receiveShadow castShadow frustumCulled={false} />;
};
