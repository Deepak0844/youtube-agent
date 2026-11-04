// Skyline generator: a varied city from a seed. Slab towers with setbacks and crowns, slim spires, glass cylinders with domes,
// water-tank style silos, stepped blocks and low podiums; glass textures vary in band pattern and tint so no two towers match.
import React, { useMemo } from "react";
import * as THREE from "three";
import type { ElOf } from "../ctx";
import { facadeTile, rng } from "../textures";

const TINTS = ["#ffffff", "#f4f8ff", "#e6f0ff", "#fff6e8", "#dff3f5", "#eef4f2"];

export const Skyline: React.FC<{ el: ElOf<"skyline"> }> = ({ el }) => {
  const group = useMemo(() => {
    const grp = new THREE.Group();
    const r = rng(el.seed * 331 + 17);
    const facades = [0, 1, 2, 3, 4, 5].map((k) => facadeTile(k));
    const matCache = new Map<string, THREE.MeshStandardMaterial>();
    const glass = (k: number, tint: number) => {
      const key = `${k}-${tint}`;
      let m = matCache.get(key);
      if (!m) { m = new THREE.MeshStandardMaterial({ map: facades[k], color: TINTS[tint], roughness: 0.38, metalness: 0.08 }); matCache.set(key, m); }
      return m;
    };
    const roof = new THREE.MeshStandardMaterial({ color: "#cfd6db", roughness: 0.8 });
    const teal = new THREE.MeshStandardMaterial({ color: "#6fb3b2", roughness: 0.28, metalness: 0.25 });
    const tankRoof = new THREE.MeshStandardMaterial({ color: "#7d95a5", roughness: 0.5, metalness: 0.2 });
    const dark = new THREE.MeshStandardMaterial({ color: "#59636b", roughness: 0.7 });
    const placed: [number, number, number][] = [];
    const [AW, AD] = el.area_m;
    const scaleUv = (g: THREE.BufferGeometry, su: number, sv: number, skip?: number[]) => {
      const uv = g.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) { if (skip?.includes(Math.floor(i / 4))) continue; uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv); }
    };
    const add = (m: THREE.Mesh, x: number, y: number, z: number) => { m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; grp.add(m); };
    for (let i = 0; i < el.count * 12 && placed.length < el.count; i++) {
      const x = (r() - 0.5) * AW;
      const z = (r() - 0.5) * AD;
      const w = 8 + r() * 9;
      if (placed.some(([px, pz, pw]) => Math.hypot(px - x, pz - z) < (pw + w) * 0.62)) continue;
      placed.push([x, z, w]);
      const h = el.min_height_m + Math.pow(r(), 1.5) * (el.max_height_m - el.min_height_m);
      const kind = Math.floor(r() * 8);
      const fk = Math.floor(r() * 6);
      const tint = Math.floor(r() * TINTS.length);
      if (kind === 0 || kind === 1) { // glass cylinder, dome crown
        const rad = w * 0.55;
        const g = new THREE.CylinderGeometry(rad, rad, h * 0.82, 32, 1, true);
        scaleUv(g, (rad * 6.28) / 10, (h * 0.82) / 14);
        add(new THREE.Mesh(g, glass(fk, tint)), x, h * 0.41, z);
        const cap = new THREE.Mesh(new THREE.CircleGeometry(rad, 32).rotateX(-Math.PI / 2), roof);
        add(cap, x, h * 0.82, z);
        add(new THREE.Mesh(new THREE.SphereGeometry(rad, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2), teal), x, h * 0.82, z);
      } else if (kind === 2) { // water tank / silo: drum on a short block with a conical roof
        const rad = w * 0.6;
        const dh = h * 0.45;
        const g = new THREE.CylinderGeometry(rad, rad, dh, 28, 1, true);
        scaleUv(g, (rad * 6.28) / 10, dh / 12);
        add(new THREE.Mesh(g, glass(fk, tint)), x, h * 0.55 + dh / 2 - dh * 0.5 + dh * 0.5, z);
        add(new THREE.Mesh(new THREE.ConeGeometry(rad * 1.04, rad * 0.55, 28), tankRoof), x, h * 0.55 + dh + rad * 0.27, z);
        const g2 = new THREE.BoxGeometry(w * 0.7, h * 0.55, w * 0.7);
        scaleUv(g2, (w * 0.7) / 10, (h * 0.55) / 14, [2, 3]);
        add(new THREE.Mesh(g2, glass((fk + 2) % 6, tint)), x, h * 0.275, z);
      } else if (kind === 3) { // slim tower with spire
        const g = new THREE.BoxGeometry(w * 0.55, h, w * 0.55);
        scaleUv(g, (w * 0.55) / 10, h / 14, [2, 3]);
        add(new THREE.Mesh(g, glass(fk, tint)), x, h / 2, z);
        add(new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.4, h * 0.14, 8), dark), x, h + h * 0.07, z);
      } else if (kind === 4) { // stepped
        let yy = 0;
        let ww = w;
        for (let s = 0; s < 3; s++) {
          const hh = h * (s === 0 ? 0.5 : 0.28);
          const g = new THREE.BoxGeometry(ww, hh, ww * 0.9);
          scaleUv(g, ww / 10, hh / 14, [2, 3]);
          add(new THREE.Mesh(g, [glass(fk, tint), glass(fk, tint), roof, roof, glass(fk, tint), glass(fk, tint)]), x, yy + hh / 2, z);
          yy += hh;
          ww *= 0.68;
        }
      } else if (kind === 5) { // low podium with a rooftop box
        const hh = Math.max(8, h * 0.35);
        const g = new THREE.BoxGeometry(w * 1.5, hh, w * 1.2);
        scaleUv(g, (w * 1.5) / 10, hh / 14, [2, 3]);
        add(new THREE.Mesh(g, [glass(fk, tint), glass(fk, tint), roof, roof, glass(fk, tint), glass(fk, tint)]), x, hh / 2, z);
        add(new THREE.Mesh(new THREE.BoxGeometry(w * 0.4, 2.4, w * 0.5), dark), x + w * 0.3, hh + 1.2, z);
      } else { // slab with setback crown
        const d = w * (0.8 + r() * 0.5);
        const g = new THREE.BoxGeometry(w, h, d);
        scaleUv(g, d / 10, h / 14, [2, 3, 4, 5]);
        const uv = g.attributes.uv as THREE.BufferAttribute;
        for (let f = 4; f < 6; f++) for (let v = 0; v < 4; v++) uv.setXY(f * 4 + v, uv.getX(f * 4 + v) * w / 10, uv.getY(f * 4 + v) * h / 14);
        add(new THREE.Mesh(g, [glass(fk, tint), glass(fk, tint), roof, roof, glass(fk, tint), glass(fk, tint)]), x, h / 2, z);
        if (r() < 0.55) {
          const g2 = new THREE.BoxGeometry(w * 0.6, h * 0.22, d * 0.6);
          scaleUv(g2, (w * 0.6) / 10, (h * 0.22) / 14, [2, 3]);
          add(new THREE.Mesh(g2, glass(fk, tint)), x, h + h * 0.11, z);
        }
      }
    }
    return grp;
  }, [el]);
  return <primitive object={group} />;
};
