// HERO EXAMPLE 6: Dubai-style land reclamation. A ring wall of rock is built in the sea, a ship pours sand inside it ("rainbowing"),
// the sand rises into new land, and a skyline grows on it. Shown as a cutaway: the sea bed layers under the cut, a glass-front block of water,
// the rock wall in section, the sand fill and the towers.
// WHAT TO COPY
//  - "Growing" is a scale from a fixed base: the sand block's base sits on the sea bed and its y-scale goes 0.05 -> 1; each tower's group
//    sits on the final land level and scales in y. The base never moves, so nothing floats.
//  - The sand jet is a particle field: each particle follows a parabola from the ship's nozzle to the pour spot; the phase comes from t.
//  - Beats are time windows built with ramp(t, a, b); every moving thing reads the same few numbers (WALL_T, POUR_T, TOWER_T).
//  - Everything uses the kit: CutawayBox faces (done in ReclamationScene), instanced rocks, city towers, boats' `rest`, makeParticles.
import * as THREE from "three";
import { glassTower, towerMaterials } from "../city";
import { instance, type Slot } from "../instancing";
import type { Models } from "../models";
import { makeParticles } from "../particles";
import { std } from "../parts";
import { rest } from "../rest";
import { clamp, rnd, smooth, ramp } from "../rng";
import { pebbleTexture, sandTexture } from "../textures";

export const RECLAMATION_MODELS = { ship: "pp_ship_meqj", boat: "pp_boat_5uel", crane: "pp_crane_17ab" } as const;
/** Heights (m): sea level 0, sea bed -12, final land +2.5. */
export const SEA_Y = 0, BED_Y = -12, LAND_Y = 2.5, BOTTOM_Y = -40;
export const LAND_X0 = -90, WALL_X0 = 18, WALL_X1 = 32, SEA_X1 = 90, DEPTH_Z = 120;
/** Story beats in seconds. */
export const WALL_T = [0.5, 4.5] as const, POUR_T = [4.5, 10.5] as const, TOWER_T = [9.5, 13.5] as const;

export type Reclamation = { root: THREE.Group; update: (t: number) => void; /** Where the sand leaves the ship. */ nozzle: THREE.Vector3; /** Where it lands. */ pour: THREE.Vector3 };

export function buildReclamation(models: Models): Reclamation {
  const root = new THREE.Group();
  const rng = rnd(4);

  // ---- ring wall: a trapezoid of rock in section (extruded along z), grows from the bed as the first beat ----
  const wallShape = new THREE.Shape();
  wallShape.moveTo(WALL_X0 - 4, BED_Y); wallShape.lineTo(WALL_X1 + 4, BED_Y); wallShape.lineTo(WALL_X1 - 1.5, 3.5); wallShape.lineTo(WALL_X0 + 1.5, 3.5); wallShape.closePath();
  const wallGeo = new THREE.ExtrudeGeometry(wallShape, { depth: DEPTH_Z, bevelEnabled: false });
  wallGeo.translate(0, 0, -DEPTH_Z); // z from -DEPTH_Z to 0: the front face sits on the cut plane
  const rockTex = pebbleTexture([1, 1]); rockTex.repeat.set(1 / 9, 1 / 9);
  const wallMat = new THREE.MeshStandardMaterial({ map: rockTex, roughness: 0.95, envMapIntensity: 0.5 });
  const wall = new THREE.Mesh(wallGeo, wallMat);
  // world-aligned UVs on the front and top, so stones have one size everywhere
  const uv = wallGeo.attributes.uv as THREE.BufferAttribute, pos = wallGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) + pos.getZ(i), pos.getY(i) + pos.getZ(i) * 0.5);
  wall.castShadow = wall.receiveShadow = true;
  const wallPivot = new THREE.Group(); wallPivot.position.y = BED_Y; wall.position.y = -BED_Y; wallPivot.add(wall); root.add(wallPivot);
  // loose boulders along the wall crest (instanced: one draw call)
  const boulderSlots: Slot[] = Array.from({ length: 70 }, () => ({ x: WALL_X0 + 2 + rng() * 11, y: 3.4 + rng() * 0.4, z: -rng() * 60 - 1, rx: rng() * 6, ry: rng() * 6, s: 0.8 + rng() * 1.4 }));
  const boulders = instance(new THREE.DodecahedronGeometry(1, 0), std("#8f8678", { roughness: 1 }), boulderSlots);
  const boulderPivot = new THREE.Group(); boulderPivot.add(boulders); root.add(boulderPivot);

  // ---- sand fill: a block whose base sits on the sea bed; its height grows while the ship pours ----
  const sandTex = sandTexture().clone(); sandTex.needsUpdate = true; sandTex.repeat.set(10, 1);
  const land = new THREE.Mesh(new THREE.BoxGeometry(WALL_X0 - LAND_X0, LAND_Y - BED_Y, DEPTH_Z), new THREE.MeshStandardMaterial({ map: sandTex, roughness: 1, envMapIntensity: 0.5 }));
  land.geometry.translate((WALL_X0 + LAND_X0) / 2, (LAND_Y - BED_Y) / 2, -DEPTH_Z / 2);
  land.castShadow = land.receiveShadow = true;
  const landPivot = new THREE.Group(); landPivot.position.y = BED_Y; landPivot.add(land); root.add(landPivot);

  // ---- ship in the open sea, pouring sand over the wall ----
  const ship = models.get(RECLAMATION_MODELS.ship, { size: 46 });
  ship.position.set(58, 0, -30); ship.rotation.y = Math.PI / 2; root.add(ship);
  rest(ship, SEA_Y, 0.2); // hull on the water: the one rule that keeps ships from floating
  const shipY = ship.position.y;
  const nozzle = new THREE.Vector3(40, 9, -30), pour = new THREE.Vector3(8, LAND_Y, -30);
  const jet = makeParticles({
    count: 260, seed: 12, size: 1.1, color: "#e7cf9c", opacity: 0.9,
    emit: (s, ph, _t, out) => { // a parabola from the nozzle to the pour spot, a little spread, falling fast at the end
      out[0] = nozzle.x + (pour.x - nozzle.x) * ph + (s.r - 0.5) * 1.4;
      out[1] = nozzle.y + (pour.y - nozzle.y) * ph + 16 * 4 * ph * (1 - ph) * 0.5;
      out[2] = nozzle.z + (s.v - 0.5) * 3.2;
    },
  });
  root.add(jet.points);

  // ---- skyline growing on the new land ----
  const mats = towerMaterials();
  const towers: { g: THREE.Group; at: number }[] = [];
  for (let i = 0; i < 9; i++) {
    const g = glassTower(mats, 8 + rng() * 6, 24 + rng() * 40 + (i % 3 === 0 ? 20 : 0), 8 + rng() * 5, i + 1, LAND_X0 + 12 + i * 8.5, -14 - rng() * 70);
    g.position.y = LAND_Y; root.add(g); towers.push({ g, at: TOWER_T[0] + (i / 9) * (TOWER_T[1] - TOWER_T[0]) * 0.7 });
  }

  const update = (t: number): void => {
    const wallK = smooth(ramp(t, WALL_T[0], WALL_T[1]));
    wallPivot.scale.y = Math.max(0.001, wallK); boulderPivot.visible = wallK > 0.95;
    ship.position.y = shipY + Math.sin(t * 1.2) * 0.15; ship.rotation.z = Math.sin(t * 0.9) * 0.015;
    const pouring = t >= POUR_T[0] + 0.5 && t < POUR_T[1];
    jet.points.visible = pouring; if (pouring) jet.update(t);
    landPivot.scale.y = Math.max(0.001, 0.04 + 0.96 * smooth(ramp(t, POUR_T[0] + 0.5, POUR_T[1])));
    towers.forEach((o) => { o.g.scale.y = Math.max(0.001, smooth(clamp(ramp(t, o.at, o.at + 2.2)))); });
  };
  update(0);
  return { root, update, nozzle, pour };
}
