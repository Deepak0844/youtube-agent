// SandPile + pour stream. The pile is a noisy dome that grows with the pour animation. The stream is thousands of small grains that
// leave the nozzle in a loose fan, fall under gravity and spread a little, with dust where they land: it reads as falling sand, not a rope of blobs.
import React, { useMemo } from "react";
import * as THREE from "three";
import type { ElOf } from "../ctx";
import { useBlock } from "../ctx";
import { animAt } from "../anim";
import { useOrigin } from "../origin";
import { blobTexture, rng, surfaceTile } from "../textures";

export const sandDome = (seed: number): THREE.BufferGeometry => {
  const g = new THREE.SphereGeometry(1, 56, 28, 0, Math.PI * 2, 0, Math.PI / 2);
  const p = g.attributes.position as THREE.BufferAttribute;
  const r = rng(seed);
  const ph = [r() * 6, r() * 6, r() * 6];
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const k = 1 + 0.05 * Math.sin(x * 6 + ph[0]!) * Math.cos(z * 5 + ph[1]!) + 0.035 * Math.sin((x - z) * 11 + ph[2]!) * (1 - y);
    // slumped cone: steeper in the middle, a skirt at the foot
    p.setXYZ(i, x * k, Math.pow(y, 1.25) * (0.96 + 0.04 * k), z * k);
  }
  g.computeVertexNormals();
  return g;
};

const GRAINS = 1600;

export const SandPile: React.FC<{ el: ElOf<"sand_pile"> }> = ({ el }) => {
  const { t } = useBlock();
  const a = animAt(el.animations, t);
  const p = a.pour ?? 1;
  const geo = useMemo(() => sandDome(el.seed * 13 + 5), [el.seed]);
  const mat = useMemo(() => {
    const s = surfaceTile("sand", el.color);
    return new THREE.MeshStandardMaterial({ map: s.texture, roughness: 1 });
  }, [el.color]);
  const R = el.radius_m * (0.35 + 0.65 * p);
  const H = Math.max(el.height_m * p, 0.001);
  // texture tile follows the world scale: 8 m per tile on a dome of unit size
  mat.map?.repeat.set((R * 2) / 8, (R * 2) / 8);
  return (
    <group>
      <mesh geometry={geo} material={mat} scale={[R, H, R]} castShadow receiveShadow />
      {a.pour !== null && a.pourFrom ? <PourStream from={a.pourFrom} top={H} progress={p} color={el.color} /> : null}
    </group>
  );
};

/** `from` is the nozzle in world metres; the stream block lives in the pile's local frame, so the Engine passes the placement offset through `useBlock().scene`. */
const PourStream: React.FC<{ from: [number, number, number]; top: number; progress: number; color: string }> = ({ from, top, progress, color }) => {
  const { t, waterY } = useBlock();
  const pileOrigin = useOrigin();
  const parts = useMemo(() => {
    const g = new THREE.IcosahedronGeometry(0.11, 0);
    const m = new THREE.MeshStandardMaterial({ color, roughness: 1, flatShading: true });
    const im = new THREE.InstancedMesh(g, m, GRAINS);
    im.frustumCulled = false;
    im.castShadow = true;
    return im;
  }, [color]);
  const dust = useMemo(() => blobTexture(0.5), []);
  const rnd = useMemo(() => { const r = rng(91); return Array.from({ length: GRAINS }, () => [r(), r(), r(), r(), r()] as const); }, []);
  const fade = Math.min(1, progress * 10, (1 - progress) * 10);
  const src = new THREE.Vector3(from[0] - pileOrigin[0], from[1] - pileOrigin[1], from[2] - pileOrigin[2]);
  const dst = new THREE.Vector3(0, top, 0);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const pp = new THREE.Vector3();
  const dist = src.distanceTo(dst);
  const arc = Math.max(0.6, dist * 0.08);
  for (let i = 0; i < GRAINS; i++) {
    const [r0, r1, r2, r3, r4] = rnd[i]!;
    const u = (t * 1.1 + r0) % 1; // 0 at the nozzle, 1 at the pile
    // slightly speed-dependent path: later grains fall faster (u^1.5 mixes the horizontal and vertical motion)
    const ux = 1 - (1 - u) ** 1.35;
    pp.lerpVectors(src, dst, ux);
    pp.y = src.y + (dst.y - src.y) * u * u * (1.4 - 0.4 * u) + Math.sin(u * Math.PI) * arc * (1 - u);
    const spread = (0.05 + 0.55 * u) * (0.4 + r1);
    const ang = r2 * Math.PI * 2;
    pp.x += Math.cos(ang) * spread * 0.9;
    pp.z += Math.sin(ang) * spread * 0.9;
    const sc = (0.5 + r3 * 0.9) * (u > 0.96 ? 0.1 : 1) * fade;
    s.set(sc, sc * (0.6 + r4 * 0.8), sc);
    q.setFromEuler(new THREE.Euler(r1 * 6, r2 * 6, r3 * 6));
    m4.compose(pp, q, s);
    parts.setMatrixAt(i, m4);
  }
  parts.instanceMatrix.needsUpdate = true;
  const wet = dst.y + pileOrigin[1] < waterY; // the pile is still under the surface: the stream lands in the sea
  const hit = new THREE.Vector3(dst.x, wet ? waterY - pileOrigin[1] : dst.y, dst.z);
  const puffs = [0, 1, 2, 3].map((k) => {
    const ph = (t * 0.7 + k / 4) % 1;
    return { ph, o: (1 - ph) * 0.5 * fade, sc: 3 + ph * 7 };
  });
  return (
    <group>
      <primitive object={parts} />
      {puffs.map((pf, k) => (
        <mesh key={k} position={[hit.x + Math.sin(k * 2.1) * 0.8, hit.y + 0.2 + pf.ph * 0.8, hit.z + Math.cos(k * 1.7) * 0.8]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={4} userData={{ noAO: true }}>
          <planeGeometry args={[pf.sc, pf.sc]} />
          <meshBasicMaterial map={dust} color={wet ? "#ffffff" : "#d8c08a"} transparent opacity={pf.o} depthWrite={false} />
        </mesh>
      ))}
    </group>
  );
};
