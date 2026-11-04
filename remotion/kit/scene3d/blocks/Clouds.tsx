// Clouds: soft clusters of round puffs drifting slowly, lit from the sun side. They cast no shadow and take no part in occlusion.
import React, { useMemo } from "react";
import * as THREE from "three";
import type { ElOf } from "../ctx";
import { useBlock } from "../ctx";
import { rng } from "../textures";

export const Clouds: React.FC<{ el: ElOf<"clouds"> }> = ({ el }) => {
  const { t } = useBlock();
  const clusters = useMemo(() => {
    const r = rng(el.seed * 53 + 7);
    return Array.from({ length: el.count }, () => ({
      x: (r() - 0.5) * el.area_m,
      z: (r() - 0.5) * el.area_m,
      y: el.altitude_m * (0.85 + r() * 0.3),
      s: 24 + r() * 40,
      puffs: Array.from({ length: 6 + Math.floor(r() * 4) }, () => [(r() - 0.5) * 2.2, (r() - 0.3) * 0.5, (r() - 0.5) * 1.1, 0.5 + r() * 0.6] as const),
    }));
  }, [el.seed, el.count, el.area_m, el.altitude_m]);
  const geo = useMemo(() => new THREE.IcosahedronGeometry(1, 2), []);
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 1, emissive: "#dfe9f2", emissiveIntensity: 0.35, fog: true }), []);
  return (
    <group userData={{ noAO: true }}>
      {clusters.map((c, i) => (
        <group key={i} position={[c.x + t * 1.5, c.y, c.z]} scale={c.s}>
          {c.puffs.map((p, k) => <mesh key={k} geometry={geo} material={mat} position={[p[0], p[1], p[2]]} scale={[p[3], p[3] * 0.7, p[3]]} />)}
        </group>
      ))}
    </group>
  );
};
