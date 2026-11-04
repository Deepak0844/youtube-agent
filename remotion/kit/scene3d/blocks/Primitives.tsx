// Plain shapes with a material (box, cylinder, sphere) and the loaded-model block with a stand-in when a model is missing.
import React, { useMemo } from "react";
import * as THREE from "three";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import type { ElOf } from "../ctx";
import { useBlock } from "../ctx";
import { modelKeyOf } from "../models";
import type { Scene3dMaterial } from "../../../../src/shared/scene3d/schema";

const Mat: React.FC<{ m: Scene3dMaterial }> = ({ m }) => (
  <meshStandardMaterial color={m.color} roughness={m.roughness} metalness={m.metalness} transparent={m.opacity < 1} opacity={m.opacity} depthWrite={m.opacity >= 1} />
);

export const BoxBlock: React.FC<{ el: ElOf<"box"> }> = ({ el }) => (
  <mesh position={[0, el.size_m[1] / 2, 0]} castShadow receiveShadow><boxGeometry args={el.size_m} /><Mat m={el.material} /></mesh>
);
export const CylinderBlock: React.FC<{ el: ElOf<"cylinder"> }> = ({ el }) => (
  <mesh position={[0, el.height_m / 2, 0]} castShadow receiveShadow><cylinderGeometry args={[el.radius_m, el.radius_m, el.height_m, 40]} /><Mat m={el.material} /></mesh>
);
export const SphereBlock: React.FC<{ el: ElOf<"sphere"> }> = ({ el }) => (
  <mesh position={[0, el.radius_m, 0]} castShadow receiveShadow><sphereGeometry args={[el.radius_m, 48, 24]} /><Mat m={el.material} /></mesh>
);

/** Clone a glTF scaled so its height is `height`, base at y = 0, centred on x/z. Materials are made matte so they sit in the stylised look. */
export function fitModel(src: THREE.Object3D, height: number, tint?: string): THREE.Group {
  const root = SkeletonUtils.clone(src) as THREE.Object3D;
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const sz = box.getSize(new THREE.Vector3());
  const c = box.getCenter(new THREE.Vector3());
  const s = height / Math.max(sz.y, 1e-6);
  root.position.set(-c.x, -box.min.y, -c.z);
  const inner = new THREE.Group();
  inner.add(root);
  inner.scale.setScalar(s);
  const wrap = new THREE.Group();
  wrap.add(inner);
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = false;
    const ms = (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshStandardMaterial[];
    ms.forEach((mm) => {
      if (mm.metalness !== undefined) { mm.metalness = 0; mm.roughness = Math.max(mm.roughness ?? 0.8, 0.65); }
      if (tint && mm.color) mm.color.lerp(new THREE.Color(tint), 0.6);
    });
  });
  return wrap;
}

export const ModelBlock: React.FC<{ el: ElOf<"model"> }> = ({ el }) => {
  const { models } = useBlock();
  const src = models[modelKeyOf(el.model)];
  const obj = useMemo(() => (src ? fitModel(src, el.height_m, el.tint) : null), [src, el.height_m, el.tint]);
  if (!obj) {
    // Stand-in: a plain block so a missing model is visible in the preview instead of silently absent.
    const f = el.footprint_m ?? el.height_m * 0.6;
    return <mesh position={[0, el.height_m / 2, 0]} castShadow><boxGeometry args={[f, el.height_m, f]} /><meshStandardMaterial color="#c9c3b8" roughness={0.9} /></mesh>;
  }
  return <primitive object={obj} />;
};
