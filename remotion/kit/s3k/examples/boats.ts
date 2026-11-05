// Boats that float: each rests on the water level (never above or below it) and bobs a little. Used by both examples.
// WHAT TO COPY: `rest()` puts the hull on the water; the bob is `sin(t * speed + phase)`, so any frame is reproducible.
import * as THREE from "three";
import { rest } from "../rest";
import type { Models } from "../models";

export type BoatSpec = { id: string; size: number; x: number; z: number; yaw: number };
export type Boats = { root: THREE.Group; update: (t: number) => void };

export function buildBoats(models: Models, specs: readonly BoatSpec[], seaY: number): Boats {
  const root = new THREE.Group();
  const boats = specs.map((s) => {
    const b = models.get(s.id, { size: s.size });
    b.position.set(s.x, 0, s.z); b.rotation.y = s.yaw; root.add(b);
    rest(b, seaY, 0.1); // hull on the water
    return { o: b, x: s.x, y: b.position.y, ph: s.x };
  });
  const update = (t: number): void => boats.forEach((b) => { b.o.position.y = b.y + Math.sin(t * 1.3 + b.ph) * 0.18; b.o.rotation.z = Math.sin(t * 1.1 + b.ph) * 0.02; b.o.position.x = b.x + Math.sin(t * 0.2 + b.ph) * 0.8; });
  return { root, update };
}
