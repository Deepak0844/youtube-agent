// HERO EXAMPLE 3: a metro train built from rounded boxes, window strips and bogies; it glides into the station.
// WHAT TO COPY
//  - One car is a function; the train is N cars on a line. Motion is `headX(t)`: an ease-out from far away to the stop mark, a pure function of t.
//  - Glass is dark with a little emissive warmth, so the windows glow under bloom without a light source.
//  - Cars sit on the rail height (RAIL_Y) by construction, never by eye.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { box, cyl, std, steel } from "../parts";
import { clamp, ramp } from "../rng";
import { RAIL_Y } from "./dims";

export type TrainOptions = {
  /** Number of cars (default 2). */
  cars?: number;
  /** Seconds when it starts moving and when it stops; x of the first car's nose at start and at the stop mark. */
  from?: number; to?: number; xStart?: number; xStop?: number;
};
export type Train = { root: THREE.Group; update: (t: number) => void };

const CAR_LEN = 7.7, GAP = 0.35;

export function buildTrain(o: TrainOptions = {}): Train {
  const n = o.cars ?? 2, from = o.from ?? 11.5, to = o.to ?? 20, xStart = o.xStart ?? -132, xStop = o.xStop ?? -38;
  const root = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: "#f4f6f8", roughness: 0.28, metalness: 0.35, envMapIntensity: 1.1 });
  const teal = std("#1fa3a8", { roughness: 0.35, metalness: 0.2 });
  const glassM = new THREE.MeshStandardMaterial({ color: "#223a4a", roughness: 0.1, metalness: 0.3, emissive: new THREE.Color("#ffd58a"), emissiveIntensity: 0.55 });
  const dark = steel("#2b2f36", 0.5);
  const cars: THREE.Group[] = [];
  for (let i = 0; i < n; i++) {
    const g = new THREE.Group(), L = CAR_LEN;
    const b = new THREE.Mesh(new RoundedBoxGeometry(L, 2.75, 2.2, 3, 0.28), body); b.position.y = 0.42 + 1.375; b.castShadow = b.receiveShadow = true; g.add(b);
    for (const s of [1, -1]) {
      box(L - 0.4, 0.34, 0.04, teal, 0, 0.95, s * 1.11, g); // teal stripe
      for (let k = 0; k < 5; k++) box(1.0, 0.85, 0.05, glassM, -2.9 + k * 1.45, 2.05, s * 1.12, g); // window strip
      for (const x of [-1.9, 1.9]) box(0.9, 1.9, 0.06, steel("#cfd8df", 0.3), x, 1.4, s * 1.12, g); // doors
    }
    box(L - 0.6, 0.12, 1.6, std("#cfd6dc"), 0, 3.22, 0, g); // roof unit
    for (const x of [-2.6, 2.6]) { // bogies: a frame and four wheels
      box(1.9, 0.5, 1.9, dark, x, 0.36, 0, g);
      for (const z of [-0.72, 0.72]) { cyl(0.32, 0.32, 0.14, dark, "z", x - 0.5, 0.32, z, g, 14); cyl(0.32, 0.32, 0.14, dark, "z", x + 0.5, 0.32, z, g, 14); }
    }
    if (i === 0) { // the front car: cab window and two headlights
      box(0.08, 1.1, 1.8, new THREE.MeshStandardMaterial({ color: "#111a22", roughness: 0.1 }), L / 2 + 0.01, 2.2, 0, g);
      const lamp = std("#fff", { emissive: new THREE.Color("#fff7d6"), emissiveIntensity: 3 });
      box(0.1, 0.25, 0.35, lamp, L / 2 + 0.04, 1.0, 0.6, g); box(0.1, 0.25, 0.35, lamp, L / 2 + 0.04, 1.0, -0.6, g);
    }
    g.position.set(0, RAIL_Y + 0.1, -1.0); // z = -1: between the two rails
    root.add(g); cars.push(g);
  }
  /** x of the nose of the train at time t: an ease-out (fast at first, gently stopping). */
  const headX = (t: number): number => { const e = clamp(ramp(t, from, to)); return xStart + (xStop - xStart) * (1 - Math.pow(1 - e, 2.2)); };
  const update = (t: number): void => { const head = headX(t); cars.forEach((c, i) => { c.position.x = head - 4 - i * (CAR_LEN + GAP); }); };
  update(0);
  return { root, update };
}
