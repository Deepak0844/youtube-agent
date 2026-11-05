// HERO EXAMPLE 5: the street above the tunnel: road, sidewalks, towers and houses, trees, lamps, benches, walking people, cars,
// and a metro station construction site (hall, glass front, scaffold, crane, containers, fence, cones).
// WHAT TO COPY
//  - Layers by depth: front sidewalk and road (z -2 .. -15), low houses and trees, then towers further back, then the far skyline.
//    Depth layering is what makes a flat street read as a city.
//  - Everything stands on y = 0 because `models.get()` clones have their base on y = 0; sidewalks sit 2-3 cm above the road so they never z-fight.
//  - People and cars move as pure functions of t (`x0 + v * t`, cars wrap around with a modulo), no state.
//  - A seeded random generator (`rnd(21)`) places things "randomly" but identically on every frame.
import * as THREE from "three";
import { box, steel, std } from "../parts";
import { glassTower, towerMaterials } from "../city";
import { asphaltTexture, paveTexture, signTexture } from "../textures";
import { rnd } from "../rng";
import type { Models } from "../models";
import { ST0, ST1, TUNNEL_MODELS, type TunnelModel } from "./dims";

export type Street = { root: THREE.Group; update: (t: number) => void };

export function buildStreet(models: Models): Street {
  const root = new THREE.Group(), r = rnd(21);
  const get = (k: TunnelModel, size: number, height = false) => models.get(TUNNEL_MODELS[k], { size, height });
  const rep = (tx: THREE.Texture, rx: number, ry: number) => { const c = tx.clone(); c.needsUpdate = true; c.wrapS = c.wrapT = THREE.RepeatWrapping; c.repeat.set(rx, ry); return c; };
  // road (asphalt, one tile = 16 m) and two sidewalks with curbs
  const road = new THREE.Mesh(new THREE.PlaneGeometry(1500, 7.5).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: rep(asphaltTexture(), 1500 / 16, 1), roughness: 0.9 }));
  road.position.set(0, 0.02, -8.75); road.receiveShadow = true; root.add(road);
  const sw = rep(paveTexture("#d9d3c4"), 250, 1);
  for (const [z, w] of [[-2.5, 5.0], [-14.3, 3.5]] as [number, number][]) {
    const s = new THREE.Mesh(new THREE.PlaneGeometry(1500, w).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: sw, roughness: 0.95 }));
    s.position.set(0, 0.03, z); s.receiveShadow = true; root.add(s);
    box(1500, 0.22, 0.3, std("#cfc9bb"), 0, 0.11, z === -2.5 ? -5.1 : -12.6, root);
  }
  // buildings: low houses on the front row, glass towers behind, a second row of taller towers further back
  const gm = towerMaterials();
  let x = -170, i = 0;
  while (x < 110) {
    if (x > ST0 - 22 && x < ST1 + 22) { x += 18; i++; continue; } // keep the station site clear
    if (i % 3 === 2) {
      const h = get(r() < 0.5 ? "house1" : "house2", 10 + r() * 3); h.position.set(x, 0, -21); root.add(h); x += 15;
      if (r() < 0.6) { const h2 = get(r() < 0.5 ? "house2" : "bld", 11 + r() * 5); h2.position.set(x, 0, -22); root.add(h2); x += 14; }
    } else {
      const w = 16 + r() * 8, hh = r() < 0.3 ? 40 + r() * 20 : 70 + r() * 60;
      root.add(glassTower(gm, w, hh, 16 + r() * 8, i + Math.floor(r() * 3), x, -52 - r() * 16)); x += w + 10 + r() * 14;
    }
    i++;
  }
  for (let k = 0; k < 16; k++) root.add(glassTower(gm, 24 + r() * 10, 70 + r() * 80, 24 + r() * 10, k + 2, -190 + k * 27 + r() * 8, -75 - r() * 40));
  // street furniture: trees, lamps, benches
  for (let k = 0; k < 14; k++) { const t = get(k % 2 ? "tree1" : "tree2", 6.5 + r() * 2.5); t.position.set(-150 + k * 22 + r() * 6, 0, -14.6); t.rotation.y = r() * 6; root.add(t); }
  for (let k = 0; k < 10; k++) { const t = get("tree1", 5.5 + r() * 2); t.position.set(-120 + k * 32 + r() * 5, 0, -1.2); root.add(t); }
  for (let k = 0; k < 20; k++) { const l = get("lamp", 7.5, true); l.position.set(-170 + k * 20, 0, -5.4); root.add(l); }
  for (let k = 0; k < 6; k++) { const b = get("bench", 2.4); b.position.set(-100 + k * 45, 0, -3.4); b.rotation.y = Math.PI; root.add(b); }
  // people on the front sidewalk and cars in two lanes: each has a start x and a speed
  const folks: { o: THREE.Object3D; x0: number; v: number }[] = [];
  (["worker", "woman", "man", "woman", "man", "worker", "woman", "man", "woman"] as const).forEach((n, k) => {
    const p = get(n, 1.75 * 1.35, true), x0 = -50 + k * 13 + r() * 4;
    p.position.set(x0, 0.03, -2.6 - (k % 2) * 1.0); p.rotation.y = k % 2 ? Math.PI / 2 : -Math.PI / 2; root.add(p); folks.push({ o: p, x0, v: k % 2 ? 0.9 : -0.9 });
  });
  const cars: { o: THREE.Object3D; x0: number; v: number }[] = [];
  (["car1", "car2", "car3", "police", "car2", "car1", "car3", "car2", "police", "car1"] as const).forEach((n, k) => {
    const c = get(n, 4.9), lane = k % 2;
    c.position.set(0, 0.03, lane ? -10.6 : -6.9); c.rotation.y = lane ? -Math.PI / 2 : Math.PI / 2; root.add(c); cars.push({ o: c, x0: -150 + k * 26 + r() * 6, v: lane ? -9 : 8 });
  });

  // ---- the station construction site above the station box ----
  const site = new THREE.Group(); root.add(site);
  const sx = (ST0 + ST1) / 2;
  const wallM = std("#e9e5da", { roughness: 0.8 }), glass = new THREE.MeshStandardMaterial({ color: "#6fb6d6", roughness: 0.12, metalness: 0.2, envMapIntensity: 1.4, transparent: true, opacity: 0.85 });
  box(28, 9, 16, wallM, sx, 4.5, -26, site); // hall
  box(24, 6.2, 0.3, glass, sx, 4.0, -17.9, site); // glass front
  for (let k = -5; k <= 5; k++) box(0.25, 6.2, 0.4, steel("#e9eef2", 0.4), sx + k * 2.4, 4.0, -17.8, site);
  box(32, 0.7, 7, std("#1d8f95", { roughness: 0.5 }), sx, 9.6, -21, site); // canopy
  const sg = new THREE.Mesh(new THREE.PlaneGeometry(16, 4), new THREE.MeshBasicMaterial({ map: signTexture("METRO", "#1d8f95"), toneMapped: false })); sg.position.set(sx, 13, -17.4); site.add(sg);
  for (const dx of [-7.6, 7.6]) box(0.4, 4.5, 0.4, steel("#dfe6ea"), sx + dx, 11.1, -17.5, site);
  const sc = steel("#f6c12e", 0.5); // scaffold
  for (let k = 0; k < 7; k++) box(0.18, 12, 0.18, sc, ST1 + 2 + k * 3, 6, -19.2, site);
  for (let lv = 1; lv <= 4; lv++) { box(19, 0.15, 1.6, std("#8a6a4a"), ST1 + 11, lv * 3, -19.8, site); box(19, 0.12, 0.12, sc, ST1 + 11, lv * 3 + 1, -19.0, site); }
  const crane = get("crane", 46, true); crane.position.set(ST0 - 9, 0, -22); crane.rotation.y = 0.4; site.add(crane);
  for (let k = 0; k < 14; k++) box(2.4, 1.6, 0.15, k % 2 ? std("#e08a1e") : std("#f2f2f2"), ST0 - 4 + k * 2.6, 0.9, -12.5, site); // hoarding fence
  for (let k = 0; k < 5; k++) { const c = get("cone", 1.4, true); c.position.set(ST0 + 2 + k * 8, 0.03, -11.5); site.add(c); }
  const ct = get("container", 7); ct.position.set(ST1 + 4, 0, -24); ct.rotation.y = Math.PI / 2; site.add(ct);
  const ct2 = get("container", 7); ct2.position.set(ST1 + 4, 2.9, -24); ct2.rotation.y = Math.PI / 2; ct2.scale.multiplyScalar(0.98); site.add(ct2);
  // a spoil heap of rocks near the machine's shaft
  for (let k = 0; k < 9; k++) { const rk = get("rock", 2.0 + r() * 2.5); rk.position.set(18 + r() * 9, 0, -2.5 - r() * 2.4); rk.rotation.y = r() * 6; root.add(rk); }

  const update = (t: number): void => {
    cars.forEach((c) => { const L = 280; c.o.position.x = ((((c.x0 + c.v * t + 150) % L) + L) % L) - 150; });
    folks.forEach((f) => { f.o.position.x = f.x0 + f.v * t; });
  };
  update(0);
  return { root, update };
}
