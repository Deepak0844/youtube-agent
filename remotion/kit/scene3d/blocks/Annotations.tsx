// Teaching marks drawn in the world: a text label that always faces the camera, a 3D arrow and a ruler with tick marks.
import React, { useMemo } from "react";
import * as THREE from "three";
import { useThree } from "@react-three/fiber";
import type { ElOf } from "../ctx";
import { labelTexture } from "../textures";

export const TextLabel: React.FC<{ el: ElOf<"text_label"> }> = ({ el }) => {
  const tex = useMemo(() => labelTexture(el.text, el.color), [el.text, el.color]);
  const w = el.height_m * 4;
  const { camera } = useThree();
  const ref = React.useRef<THREE.Mesh>(null);
  // Face the camera (yaw only) at render time.
  if (ref.current) ref.current.lookAt(camera.position.x, ref.current.getWorldPosition(new THREE.Vector3()).y, camera.position.z);
  return (
    <mesh ref={ref} position={[0, el.height_m / 2, 0]} renderOrder={5} userData={{ noAO: true }}>
      <planeGeometry args={[w, el.height_m]} />
      <meshBasicMaterial map={tex} transparent depthWrite={false} toneMapped={false} />
    </mesh>
  );
};

export const ArrowBlock: React.FC<{ el: ElOf<"arrow"> }> = ({ el }) => {
  const k = el.at.scale || 1;
  const from = new THREE.Vector3(0, 0, 0);
  const y0 = el.at.y ?? 0;
  const to = new THREE.Vector3((el.to[0] - el.at.x) / k, (el.to[1] - y0) / k, (el.to[2] - el.at.z) / k);
  const len = to.length();
  const dir = to.clone().normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  const th = el.thickness_m;
  const head = Math.min(len * 0.35, th * 5);
  const mid = from.clone().addScaledVector(dir, (len - head) / 2);
  const tip = from.clone().addScaledVector(dir, len - head / 2);
  return (
    <group userData={{ noAO: true }}>
      <mesh position={mid} quaternion={q} castShadow><cylinderGeometry args={[th / 2, th / 2, Math.max(len - head, 0.01), 16]} /><meshStandardMaterial color={el.color} roughness={0.5} emissive={el.color} emissiveIntensity={0.25} /></mesh>
      <mesh position={tip} quaternion={q} castShadow><coneGeometry args={[th * 1.6, head, 20]} /><meshStandardMaterial color={el.color} roughness={0.5} emissive={el.color} emissiveIntensity={0.25} /></mesh>
    </group>
  );
};

export const RulerBlock: React.FC<{ el: ElOf<"ruler"> }> = ({ el }) => {
  const L = el.length_m;
  const th = Math.max(L * 0.004, 0.08);
  const axis = el.axis === "x" ? new THREE.Vector3(1, 0, 0) : el.axis === "y" ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  const ticks = Array.from({ length: el.ticks + 1 }, (_, i) => (i / el.ticks) * L);
  return (
    <group userData={{ noAO: true }}>
      <mesh position={axis.clone().multiplyScalar(L / 2)} scale={[el.axis === "x" ? L : th, el.axis === "y" ? L : th, el.axis === "z" ? L : th]}>
        <boxGeometry args={[1, 1, 1]} /><meshStandardMaterial color={el.color} roughness={0.5} emissive={el.color} emissiveIntensity={0.3} />
      </mesh>
      {ticks.map((d) => (
        <mesh key={d} position={axis.clone().multiplyScalar(d)}><boxGeometry args={[th * 5, th * 1.2, th * 5]} /><meshStandardMaterial color={el.color} emissive={el.color} emissiveIntensity={0.3} /></mesh>
      ))}
    </group>
  );
};
