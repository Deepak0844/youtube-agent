// Particles (dust, spray, smoke, sparks): a THREE.Points cloud whose positions are recomputed on the CPU every frame from the time t,
// so any frame renders the same without state. You give `emit(seed, phase, t, out)`; the helper cycles the phase 0..1 per particle.
import * as THREE from "three";
import { rnd } from "./rng";
import { dustSprite } from "./textures";

/** Per-particle random numbers, fixed by the seed. */
export type Seed = { a: number; r: number; p: number; sp: number; v: number };
export function particleSeeds(count: number, seed = 1): Seed[] {
  const r = rnd(seed);
  return Array.from({ length: Math.max(0, count) }, () => ({ a: r() * Math.PI * 2, r: r(), p: r(), sp: 0.12 + r() * 0.3, v: r() }));
}
/** Phase 0..1 of a looping particle at time t (each has its own start offset `p` and speed `sp`). Pure: the same t gives the same phase. */
export const phaseOf = (t: number, s: Pick<Seed, "p" | "sp">): number => (((t * s.sp + s.p) % 1) + 1) % 1;

export type ParticleOptions = {
  count: number;
  seed?: number;
  /** Size in metres (sizeAttenuation on). */
  size?: number;
  color?: string;
  opacity?: number;
  /** Writes the particle's position into `out` [x, y, z]. `ph` is its 0..1 life phase, `t` seconds. */
  emit: (s: Seed, ph: number, t: number, out: [number, number, number], i: number) => void;
};
export type ParticleField = { points: THREE.Points; update: (t: number) => void };

export function makeParticles(o: ParticleOptions): ParticleField {
  const seeds = particleSeeds(o.count, o.seed ?? 1);
  const pos = new Float32Array(o.count * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ map: dustSprite(), color: o.color ?? "#d9c19a", size: o.size ?? 1.2, sizeAttenuation: true, transparent: true, opacity: o.opacity ?? 0.6, depthWrite: false, fog: true });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  const out: [number, number, number] = [0, 0, 0];
  const update = (t: number) => {
    seeds.forEach((s, i) => { o.emit(s, phaseOf(t, s), t, out, i); pos[i * 3] = out[0]; pos[i * 3 + 1] = out[1]; pos[i * 3 + 2] = out[2]; });
    geo.attributes.position!.needsUpdate = true;
  };
  return { points, update };
}
