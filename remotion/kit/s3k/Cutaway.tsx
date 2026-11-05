// Cutaway ground: the cut face of a block of earth at z = `z` (viewer on the +z side), showing layers (strata) with optional tilt,
// with holes punched through it (a tunnel, a station, a shaft) so you see what is behind. Layers use a world-aligned UV map and a
// RepeatWrapping texture, so a pebble is the same size on every face. Put the ground top behind the face with <World ground={{zMax: 0}} />.
import React, { useMemo } from "react";
import type {} from "@react-three/fiber"; // loads the JSX types for <primitive>
import * as THREE from "three";
import { glassWaterTexture, strataTexture, STRATA_DEFAULT, type Layer } from "./textures";
import { std } from "./parts";
import { useStable } from "./time";

export type Pt = [number, number];
export type CutawayProps = {
  /** Horizontal extent of the face (x). */
  x0: number; x1: number;
  /** Ground surface height (default 0) and the bottom of the block (negative). */
  top?: number; bottom: number;
  /** Polygons (x, y) cut out of the face, e.g. a tunnel mouth. They must lie inside the face. */
  holes?: Pt[][];
  /** Soil layers from top to bottom (default: the proof's sand, clay and gravel). `pebbles: true` draws stones in that layer. */
  layers?: readonly Layer[];
  /** The layers slope by this many degrees (0 = flat, +ve rises to +x). Limit +-25. */
  tiltDeg?: number;
  /** Metres covered by one texture tile (default 52). Smaller = thinner layers. */
  tile?: number;
  /** Plane of the face (default 0). */
  z?: number;
  /** A low wall along the top edge of the cut (default on): hides the seam between face and ground. */
  parapet?: boolean | { height?: number; color?: string };
  /** A strip of sea in FRONT of the face (z > face): `{ y: water level, depth: how far out (default 40) }`, with a foam line at the face. */
  seaStrip?: { y: number; depth?: number; color?: string };
  /** An aquarium-like block: glass front, water gradient behind it, so a water cross-section can be shown (land on one side, sea on the other). */
  waterBlock?: { x0: number; x1: number; y0: number; y1: number; depth?: number };
};

export const TILT_LIMIT_DEG = 25;

/** World-aligned UV for a point on the face: one tile covers `tile` metres; tilt shears the layers. Pure, unit-tested. */
export function strataUV(x: number, y: number, tile: number, tiltDeg: number, top = 0): [number, number] {
  const slope = Math.tan((Math.max(-TILT_LIMIT_DEG, Math.min(TILT_LIMIT_DEG, tiltDeg)) * Math.PI) / 180);
  return [x / tile, (y - top - slope * x) / tile + 1];
}

/** The face geometry: a rectangle x0..x1 by bottom..top with holes punched out. */
export function buildCutFace(p: Pick<CutawayProps, "x0" | "x1" | "top" | "bottom" | "holes" | "tile" | "tiltDeg">): THREE.ShapeGeometry {
  const top = p.top ?? 0;
  const s = new THREE.Shape();
  s.moveTo(p.x0, p.bottom); s.lineTo(p.x1, p.bottom); s.lineTo(p.x1, top); s.lineTo(p.x0, top); s.closePath();
  for (const h of p.holes ?? []) {
    const path = new THREE.Path();
    h.forEach(([x, y], i) => (i === 0 ? path.moveTo(x, y) : path.lineTo(x, y)));
    path.closePath();
    s.holes.push(path);
  }
  const g = new THREE.ShapeGeometry(s);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) { const [u, v] = strataUV(pos.getX(i), pos.getY(i), p.tile ?? 52, p.tiltDeg ?? 0, top); uv.setXY(i, u, v); }
  return g;
}

export const CutawayBox: React.FC<CutawayProps> = (props) => {
  const p = useStable(props);
  const root = useMemo(() => {
    const g = new THREE.Group();
    const top = p.top ?? 0;
    const tex = strataTexture(p.layers ?? STRATA_DEFAULT).clone();
    tex.needsUpdate = true; tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.anisotropy = 8;
    const face = new THREE.Mesh(buildCutFace(p), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0, envMapIntensity: 0.5 }));
    face.receiveShadow = true;
    g.add(face);
    if (p.parapet !== false) {
      const o = typeof p.parapet === "object" ? p.parapet : {};
      const h = o.height ?? 0.5;
      const w = new THREE.Mesh(new THREE.BoxGeometry(p.x1 - p.x0, h, 0.3), std(o.color ?? "#d4cec0"));
      w.position.set((p.x0 + p.x1) / 2, top + h / 2, -0.15); w.castShadow = w.receiveShadow = true;
      g.add(w);
    }
    if (p.seaStrip) {
      const d = p.seaStrip.depth ?? 40;
      const sea = new THREE.Mesh(new THREE.PlaneGeometry(p.x1 - p.x0, d).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: p.seaStrip.color ?? "#37c6cf", roughness: 0.28, metalness: 0.05, envMapIntensity: 0.9 }));
      sea.position.set((p.x0 + p.x1) / 2, p.seaStrip.y, d / 2); sea.receiveShadow = true;
      const foam = new THREE.Mesh(new THREE.PlaneGeometry(p.x1 - p.x0, 1.6).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: "#effcfc", transparent: true, opacity: 0.85 }));
      foam.position.set((p.x0 + p.x1) / 2, p.seaStrip.y + 0.04, 0.8);
      g.add(sea, foam);
    }
    if (p.waterBlock) {
      const b = p.waterBlock, d = b.depth ?? 12, w = b.x1 - b.x0, h = b.y1 - b.y0;
      const water = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ map: glassWaterTexture(), roughness: 0.2, metalness: 0.05, envMapIntensity: 0.6 }));
      water.position.set((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, -d / 2 - 0.05);
      const glass = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ color: "#bfe8f2", roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.18, envMapIntensity: 1.4, depthWrite: false }));
      glass.position.set((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, 0.02);
      g.add(water, glass);
    }
    g.position.z = p.z ?? 0;
    return g;
  }, [p]);
  return <primitive object={root} />;
};
