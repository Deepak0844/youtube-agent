import React, { useMemo } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

type V = [number, number, number];

/** Flat pastel palette shared by every model. */
export const C = {
  steel: "#f3c969", steelDark: "#d9a93f", red: "#e8826f", white: "#f7f4ee", concrete: "#cfd3d8", concreteDark: "#aeb4bb",
  glass: "#a9cde6", glassDark: "#86aec9", dark: "#4a5560", cable: "#3b434c", hook: "#ec6a4c", black: "#2d3238",
  grass: "#bfe0a8", grassDark: "#9fcf8a", leaf1: "#8fd19e", leaf2: "#a8dba5", leaf3: "#76c18a", trunk: "#b48a6a", road: "#9aa4ad",
  roofRed: "#e39a86", roofBlue: "#8fb3d4", wall1: "#fbe6c8", wall2: "#f5d0d0", wall3: "#d7e8d0", wall4: "#e6dcf0", door: "#8a6b58",
  skin: "#f1c7a6", shirt: "#e8826f", pants: "#6f8fb5", water: "#8ec5de", hull: "#c85c55", mount: "#b9b7c9", mountDark: "#9c9ab4", snow: "#fbfcff",
} as const;

const col = new THREE.Color();

/** Collects boxes, beams, cylinders, cones and blobs, each with its own colour, and merges them into ONE flat-shaded mesh. */
export class Merger {
  private parts: THREE.BufferGeometry[] = [];
  private add(g0: THREE.BufferGeometry, color: string) {
    const g = g0.index ? g0.toNonIndexed() : g0;
    g.deleteAttribute("uv");
    const n = g.getAttribute("position").count;
    const a = new Float32Array(n * 3);
    col.set(color);
    for (let i = 0; i < n; i++) col.toArray(a, i * 3);
    g.setAttribute("color", new THREE.BufferAttribute(a, 3));
    this.parts.push(g);
  }
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, color: string, rotY = 0) {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    if (rotY) g.rotateY(rotY);
    g.translate(cx, cy, cz);
    this.add(g, color);
  }
  /** A box standing on y0 (its bottom), centred on x/z. */
  block(cx: number, y0: number, cz: number, sx: number, sy: number, sz: number, color: string) {
    this.box(cx, y0 + sy / 2, cz, sx, sy, sz, color);
  }
  beam(a: V, b: V, t: number, color: string) {
    const A = new THREE.Vector3(...a);
    const B = new THREE.Vector3(...b);
    const len = A.distanceTo(B);
    if (len < 1e-6) return;
    const g = new THREE.BoxGeometry(t, len, t);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize()));
    const m = A.clone().add(B).multiplyScalar(0.5);
    g.translate(m.x, m.y, m.z);
    this.add(g, color);
  }
  cyl(cx: number, y0: number, cz: number, rTop: number, rBot: number, h: number, color: string, seg = 10) {
    const g = new THREE.CylinderGeometry(rTop, rBot, h, seg);
    g.translate(cx, y0 + h / 2, cz);
    this.add(g, color);
  }
  /** A wheel: a cylinder lying along the z axis. */
  wheel(cx: number, cy: number, cz: number, r: number, w: number, color: string) {
    const g = new THREE.CylinderGeometry(r, r, w, 12);
    g.rotateX(Math.PI / 2);
    g.translate(cx, cy, cz);
    this.add(g, color);
  }
  blob(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, color: string, detail = 0) {
    const g = new THREE.IcosahedronGeometry(1, detail);
    g.scale(rx, ry, rz);
    g.translate(cx, cy, cz);
    this.add(g, color);
  }
  /** A triangular prism along z (a pitched roof): base width w, ridge height h, length l, bottom at y0. */
  roof(cx: number, y0: number, cz: number, w: number, h: number, l: number, color: string) {
    const s = new THREE.Shape([new THREE.Vector2(-w / 2, 0), new THREE.Vector2(w / 2, 0), new THREE.Vector2(0, h)]);
    const g = new THREE.ExtrudeGeometry(s, { depth: l, bevelEnabled: false });
    g.translate(cx, y0, cz - l / 2);
    this.add(g, color);
  }
  /** A flat polygon (x,y points, counter-clockwise) pushed along z by `depth`, centred on cz, bottom at y0. */
  prism(pts: [number, number][], depth: number, cx: number, y0: number, cz: number, color: string) {
    const g = new THREE.ExtrudeGeometry(new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y))), { depth, bevelEnabled: false });
    g.translate(cx, y0, cz - depth / 2);
    this.add(g, color);
  }
  /** An arc of a ring in the xy plane (a hook): radius r, tube t, `arc` radians from the top, centred at cx,cy. */
  hook(cx: number, cy: number, cz: number, r: number, t: number, arc: number, color: string) {
    const g = new THREE.TorusGeometry(r, t, 6, 12, arc);
    g.rotateZ(Math.PI / 2 + (Math.PI * 2 - arc) / 2); // the gap in the ring faces up
    g.translate(cx, cy, cz);
    this.add(g, color);
  }
  build(): THREE.BufferGeometry {
    const g = mergeGeometries(this.parts)!;
    g.computeVertexNormals();
    return g;
  }
}

/** Where a sling meets a lifted load: the corners of a small plate on its top, this fraction of the load's height from the middle. */
export const LIFT_A = 0.05;

/** One merged, flat-shaded, shadow-casting mesh from a builder. The builder runs once per input change. */
export const Built: React.FC<{ build: (m: Merger) => void; deps: readonly unknown[]; cast?: boolean; receive?: boolean; position?: V }> = ({ build, deps, cast = true, receive = true, position }) => {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const geo = useMemo(() => { const m = new Merger(); build(m); return m.build(); }, deps);
  return (
    <mesh geometry={geo} castShadow={cast} receiveShadow={receive} position={position}>
      <meshStandardMaterial vertexColors flatShading roughness={0.85} metalness={0} />
    </mesh>
  );
};

/** A tiling window texture (one tile = one floor by one bay), drawn once on a canvas. */
let windowTex: THREE.CanvasTexture | undefined;
export function windowTexture(): THREE.CanvasTexture {
  if (windowTex) return windowTex;
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#b9d6ea";
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = "#8db4d0";
  g.fillRect(0, 108, 128, 20); // floor band
  for (let i = 0; i < 2; i++) {
    g.fillStyle = (i + 1) % 2 ? "#e9f4fb" : "#fff3c9";
    g.fillRect(10 + i * 60, 14, 48, 78);
    g.fillStyle = "rgba(120,160,190,0.5)";
    g.fillRect(10 + i * 60, 52, 48, 4); // mullion
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  windowTex = t;
  return t;
}

/** A box with the window texture on its four sides: one tile per floor (`floorH`) and bay (`bay`), so windows keep real size. */
export const GlassBox: React.FC<{ w: number; h: number; d: number; y0?: number; x?: number; z?: number; floorH?: number; bay?: number; tint?: string }> = ({ w, h, d, y0 = 0, x = 0, z = 0, floorH = 4, bay = 3.6, tint = "#ffffff" }) => {
  const geo = useMemo(() => {
    const g = new THREE.BoxGeometry(w, h, d);
    const uv = g.getAttribute("uv") as THREE.BufferAttribute;
    // faces: +x, -x, +y, -y, +z, -z (4 vertices each). Side faces tile; top and bottom take a plain band colour.
    const faceW = [d, d, 0, 0, w, w];
    for (let f = 0; f < 6; f++) {
      for (let i = 0; i < 4; i++) {
        const k = f * 4 + i;
        if (f === 2 || f === 3) uv.setXY(k, 0.5, 0.05);
        else uv.setXY(k, uv.getX(k) * Math.max(1, Math.round(faceW[f]! / bay)), uv.getY(k) * Math.max(1, Math.round(h / floorH)));
      }
    }
    g.translate(x, y0 + h / 2, z);
    return g;
  }, [w, h, d, y0, x, z, floorH, bay]);
  return (
    <mesh geometry={geo} castShadow receiveShadow>
      <meshStandardMaterial map={windowTexture()} color={tint} flatShading roughness={0.55} />
    </mesh>
  );
};
