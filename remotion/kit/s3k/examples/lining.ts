// HERO EXAMPLE 2: the finished tunnel behind the machine: concrete lining rings (instanced), grout, track bed, sleepers, rails and
// service pipes, plus the polygon that is punched out of the cut face so the tunnel is visible from outside.
// WHAT TO COPY
//  - Repeating things are INSTANCED (one InstancedMesh per segment shape, one matrix per ring): 100+ rings cost almost nothing.
//  - Each ring gets a slightly different tint (`tint`), darker with distance: identical copies look fake, a little variety looks built.
//  - `tunnelHole()` gives the polygon for <CutawayBox holes={...}>: the face and the things behind it are defined from the same numbers.
//  - A gap is left where the station box is (rings are skipped there), and services stop at the station walls.
import * as THREE from "three";
import { box, cyl, sector, std, steel } from "../parts";
import { instance, rowSlots, type Slot } from "../instancing";
import { rnd } from "../rng";
import { liningSegment } from "./tbm";
import { BORE, HOLE_BOTTOM, RAIL_Y, RING_LEN, ST0, ST1, STATION_TOP, XMIN, YA } from "./dims";

/** The hole in the cut face: the tunnel from the machine to the far end, with the station box widening it in the middle. */
export function tunnelHole(): [number, number][] {
  return [[XMIN - 30, YA + BORE], [ST0, YA + BORE], [ST0, STATION_TOP], [ST1, STATION_TOP], [ST1, YA + BORE], [0, YA + BORE], [0, HOLE_BOTTOM], [XMIN - 30, HOLE_BOTTOM]];
}

/** x of the start of every lining ring behind the machine, skipping the station box. Pure. */
export function ringStarts(): number[] {
  const xs: number[] = [];
  for (let i = 0; ; i++) {
    const x0 = -9.0 - RING_LEN * (i + 1);
    if (x0 < XMIN) break;
    if (x0 + RING_LEN > ST0 - 0.01 && x0 < ST1) continue;
    xs.push(x0);
  }
  return xs;
}

export type Lining = { root: THREE.Group; update: (t: number) => void };

export function buildTunnel(): Lining {
  const root = new THREE.Group(); root.position.y = YA;
  const rng = rnd(11);
  const xs = ringStarts();
  const slots: Slot[] = xs.map((x) => ({ x, y: 0, z: 0 }));
  const mat = std("#ffffff", { roughness: 0.85, metalness: 0 });
  for (let j = 0; j < 5; j++) {
    const jitter = xs.map((_, i) => 0.86 + rng() * 0.1 - Math.min(0.08, i * 0.0015) + (j % 2) * 0.02);
    root.add(instance(liningSegment(j), mat, slots, { tint: (i) => new THREE.Color().setRGB(0.86 * jitter[i]!, 0.84 * jitter[i]!, 0.8 * jitter[i]!) }));
  }
  // grout between lining and rock
  const grout = std("#8c8174", { roughness: 1, side: THREE.DoubleSide });
  for (const [a, b] of [[-9.5, ST1], [ST0, XMIN - 30]] as [number, number][]) {
    const m = new THREE.Mesh(sector(BORE, 3.96, -Math.PI / 2, Math.PI / 2, Math.abs(b - a)), grout); m.position.x = Math.min(a, b); m.receiveShadow = true; root.add(m);
  }
  // track bed, sleepers, rails
  const bedLen = -10 - XMIN + 30;
  box(bedLen, 1.0, 2.45, std("#a9a498", { roughness: 0.9 }), -10 - bedLen / 2, RAIL_Y - YA - 0.5, -1.22, root);
  const sl = instance(new THREE.BoxGeometry(0.3, 0.12, 2.0), std("#4a4540", { roughness: 0.9 }), rowSlots(Math.floor(bedLen / 0.9), [-10, RAIL_Y - YA + 0.06, -1.0], [-0.9, 0, 0]), { shadows: false });
  sl.receiveShadow = true; root.add(sl);
  const railM = steel("#9aa2ab", 0.3);
  for (const z of [-0.3, -1.7]) box(bedLen, 0.16, 0.14, railM, -10 - bedLen / 2, RAIL_Y - YA + 0.2, z, root);
  // services along the tunnel (not through the station hall): duct with collars, two pipes, a cable tray
  const duct = std("#f2a31f", { roughness: 0.5, metalness: 0.2 }), pipeB = steel("#3c8fd0", 0.4), tray = steel("#8892a0", 0.5);
  for (const [a, b] of [[-9.6, ST1], [ST0, XMIN]] as [number, number][]) {
    const L = Math.abs(b - a), xm = (a + b) / 2;
    cyl(0.4, 0.4, L, duct, "x", xm, 2.3, -1.6, root, 20);
    for (let x = a - 1; x > b; x -= 4) cyl(0.43, 0.43, 0.14, steel("#444c58", 0.5), "x", x, 2.3, -1.6, root, 20);
    cyl(0.16, 0.16, L, pipeB, "x", xm, -0.6, -3.15, root, 10);
    cyl(0.16, 0.16, L, steel("#d6483a", 0.4), "x", xm, -1.0, -3.0, root, 10);
    box(L, 0.06, 0.5, tray, xm, 0.7, -3.2, root);
  }
  return { root, update: () => undefined }; // static: nothing moves in the finished tunnel
}
