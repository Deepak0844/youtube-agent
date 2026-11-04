// Crowd / people: small stylised figures (capsule body, round head, legs) scattered over an area, instanced in three draw calls.
// Deterministic from the seed; each person has its own shirt, skin tone, facing and a faint idle sway.
import React, { useMemo } from "react";
import * as THREE from "three";
import type { ElOf } from "../ctx";
import { useBlock } from "../ctx";
import { rng } from "../textures";

const SHIRTS = ["#d94f3f", "#2f6fb5", "#f0c24a", "#3b9d6b", "#8b5fbf", "#f2f2ee", "#e8833a", "#35383d", "#4bb7c4"];
const SKINS = ["#f1c9a5", "#d9a074", "#a97650", "#7a5133", "#f6d7bd"];

export const Crowd: React.FC<{ el: ElOf<"crowd"> }> = ({ el }) => {
  const { t, groundAt } = useBlock();
  const H = el.person_height_m;
  const spots = useMemo(() => {
    const r = rng(el.seed * 977 + 13);
    const out: { x: number; z: number; yaw: number; shirt: THREE.Color; skin: THREE.Color; ph: number; s: number }[] = [];
    const minD = H * 0.55;
    for (let tries = 0; tries < el.count * 40 && out.length < el.count; tries++) {
      const x = (r() - 0.5) * el.area_m[0];
      const z = (r() - 0.5) * el.area_m[1];
      if (out.some((o) => Math.hypot(o.x - x, o.z - z) < minD)) continue;
      out.push({ x, z, yaw: r() * 6.28, shirt: new THREE.Color(SHIRTS[Math.floor(r() * SHIRTS.length)]!), skin: new THREE.Color(SKINS[Math.floor(r() * SKINS.length)]!), ph: r() * 6.28, s: 0.92 + r() * 0.16 });
    }
    return out;
  }, [el.seed, el.count, el.area_m, H]);
  const parts = useMemo(() => {
    const mk = (g: THREE.BufferGeometry, color?: string) => {
      const im = new THREE.InstancedMesh(g, new THREE.MeshStandardMaterial({ color: color ?? "#ffffff", roughness: 0.7 }), Math.max(1, spots.length));
      im.castShadow = true; im.receiveShadow = true; im.frustumCulled = false;
      return im;
    };
    const torso = new THREE.CapsuleGeometry(0.2, 0.55, 4, 10).translate(0, 0.98, 0);
    const head = new THREE.SphereGeometry(0.16, 16, 12).translate(0, 1.55, 0);
    const legs = new THREE.CapsuleGeometry(0.11, 0.55, 4, 8).scale(1.5, 1, 1).translate(0, 0.38, 0);
    return { torso: mk(torso), head: mk(head), legs: mk(legs, "#2b2f3a") };
  }, [spots.length]);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  spots.forEach((s, i) => {
    const sway = Math.sin(t * 1.4 + s.ph) * 0.03;
    const sc = (H / 1.75) * s.s;
    q.setFromAxisAngle(up, s.yaw);
    const y = groundAt(0, 0) * 0; // placed on the element's own base; the Engine already snapped it
    m.compose(new THREE.Vector3(s.x, y + Math.abs(Math.sin(t * 2 + s.ph)) * 0.01, s.z), q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), sway)), new THREE.Vector3(sc, sc, sc));
    parts.torso.setMatrixAt(i, m); parts.torso.setColorAt(i, s.shirt);
    parts.head.setMatrixAt(i, m); parts.head.setColorAt(i, s.skin);
    parts.legs.setMatrixAt(i, m);
  });
  [parts.torso, parts.head, parts.legs].forEach((im) => { im.count = spots.length; im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true; });
  return (
    <group>
      <primitive object={parts.torso} /><primitive object={parts.head} /><primitive object={parts.legs} />
    </group>
  );
};
