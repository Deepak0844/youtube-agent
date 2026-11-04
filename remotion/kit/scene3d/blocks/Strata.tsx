// Terrain / strata cross-section block: a slab of ground cut open so you see its layers (tilted bands, pebble beds, wavy edges),
// optionally with a pebble-covered ramp running down into the water. Local origin: top-left-front edge at x = 0, centred in z.
import React, { useMemo } from "react";
import * as THREE from "three";
import { ShapeUtils } from "three";
import type { ElOf } from "../ctx";
import { pebbleTile, strataTile, surfaceTile } from "../textures";

type P2 = [number, number];

/** Builds the slab: front/back caps (strata), top (surface), slope (pebbles), ends and bottom. UVs are metres / tile size. */
export function slabGeometry(w: number, h: number, d: number, ramp: number, tile: { strata: number; surface: number; pebble: number }): THREE.BufferGeometry {
  const flat = ramp > 0 ? w - ramp : w;
  // The ramp drops at most 95% of its run (about 43 degrees); a deeper slab continues with a vertical end below it.
  const drop = Math.min(h, ramp * 0.95);
  const poly: P2[] = ramp > 0 ? (drop < h ? [[0, 0], [flat, 0], [w, -drop], [w, -h], [0, -h]] : [[0, 0], [flat, 0], [w, -h], [0, -h]]) : [[0, 0], [w, 0], [w, -h], [0, -h]];
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const groups: { start: number; count: number; mat: number }[] = [];
  const push = (mat: number, verts: number[][], n: number[], uvs: number[][]) => {
    const start = pos.length / 3;
    for (let i = 0; i < verts.length; i++) { pos.push(...verts[i]!); nor.push(...n); uv.push(...uvs[i]!); }
    const last = groups[groups.length - 1];
    if (last && last.mat === mat && last.start + last.count === start) last.count += verts.length; else groups.push({ start, count: verts.length, mat });
  };
  const hz = d / 2;
  // caps
  const tri = ShapeUtils.triangulateShape(poly.map(([x, y]) => new THREE.Vector2(x, y)), []);
  const t = tile.strata;
  const capFront: number[][] = [];
  const capBack: number[][] = [];
  for (const f of tri) for (const i of f) { capFront.push([poly[i]![0], poly[i]![1], hz]); }
  for (const f of tri) for (const i of [f[0]!, f[2]!, f[1]!]) { capBack.push([poly[i]![0], poly[i]![1], -hz]); }
  push(2, capFront, [0, 0, 1], capFront.map((v) => [v[0]! / t, v[1]! / t]));
  push(2, capBack, [0, 0, -1], capBack.map((v) => [-v[0]! / t, v[1]! / t]));
  // edges
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    const n = [-dy / len, dx / len, 0]; // the polygon runs clockwise seen from +z, so outward is (-dy, dx)
    const top = a[1] === 0 && b[1] === 0;
    const slope = dy !== 0 && dx !== 0;
    const bottom = a[1] === -h && b[1] === -h;
    const mat = top ? 0 : slope ? 1 : bottom ? 3 : 2;
    const tl = mat === 0 ? tile.surface : mat === 1 ? tile.pebble : t;
    const q = [[a[0], a[1], hz], [b[0], b[1], hz], [b[0], b[1], -hz], [a[0], a[1], -hz]];
    const u = mat === 2 ? [[hz / t, a[1] / t], [hz / t, b[1] / t], [-hz / t, b[1] / t], [-hz / t, a[1] / t]] : [[a[0] / tl, hz / tl], [b[0] / tl, hz / tl], [b[0] / tl, -hz / tl], [a[0] / tl, -hz / tl]];
    // The polygon runs counter-clockwise seen from +z, so quad (front a, front b, back b, back a) faces outward with this winding.
    push(mat, [q[0]!, q[1]!, q[2]!, q[0]!, q[2]!, q[3]!], n, [u[0]!, u[1]!, u[2]!, u[0]!, u[2]!, u[3]!]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  groups.forEach((gr) => g.addGroup(gr.start, gr.count, gr.mat));
  return g;
}

export const StrataCut: React.FC<{ el: ElOf<"strata_cut"> }> = ({ el }) => {
  const [w, h, d] = el.size_m;
  const built = useMemo(() => {
    const strata = strataTile(el.layers, 11 + el.layers.length);
    strata.texture.rotation = (el.tilt_deg * Math.PI) / 180;
    const surface = surfaceTile(el.top);
    const pebble = pebbleTile();
    const geo = slabGeometry(w, h, d, el.ramp_m, { strata: strata.tileM, surface: surface.tileM, pebble: pebble.tileM });
    const mats = [
      new THREE.MeshStandardMaterial({ map: surface.texture, roughness: 1 }),
      new THREE.MeshStandardMaterial({ map: pebble.texture, roughness: 0.9 }),
      new THREE.MeshStandardMaterial({ map: strata.texture, roughness: 0.95 }),
      new THREE.MeshStandardMaterial({ color: "#8a7a68", roughness: 1 }),
    ];
    return { geo, mats };
  }, [el.layers, el.tilt_deg, el.top, el.ramp_m, w, h, d]);
  return <mesh geometry={built.geo} material={built.mats} castShadow receiveShadow frustumCulled={false} />;
};
