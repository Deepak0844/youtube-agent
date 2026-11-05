// HERO EXAMPLE 4: the underground station: slabs, platform with a safety line, columns, glowing lamp panels, signs, and a few catalogue
// props (workers, cones, barriers). WHAT TO COPY
//  - The room is made of a few big boxes and planes in the dug hole; character comes from the textures (concrete with a teal band),
//    the emissive lamps and the signs, not from geometry.
//  - Props come from the model loader: `models.get(id, { size, height })` gives a clone that already stands on y = 0, so each prop
//    is put on the platform with ONE y (the platform height) and cannot float.
//  - Signs use a MeshBasicMaterial with toneMapped:false: they stay crisp and bright through the finish chain.
import * as THREE from "three";
import { box, std } from "../parts";
import { concreteTexture, signTexture } from "../textures";
import type { Models } from "../models";
import { HOLE_BOTTOM, LIN_I, RAIL_Y, ST0, ST1, STATION_TOP, TUNNEL_MODELS, YA } from "./dims";

export function buildStation(models: Models): THREE.Group {
  const root = new THREE.Group();
  const tile = (t: THREE.Texture, rx: number, ry: number) => { const c = t.clone(); c.needsUpdate = true; c.wrapS = c.wrapT = THREE.RepeatWrapping; c.repeat.set(rx, ry); return c; };
  const conc = std("#ffffff", { map: tile(concreteTexture(), 6, 1.6), roughness: 0.9, metalness: 0 });
  const W = ST1 - ST0, xm = (ST0 + ST1) / 2, Hh = STATION_TOP - HOLE_BOTTOM;
  // back wall
  const back = new THREE.Mesh(new THREE.PlaneGeometry(W, Hh), new THREE.MeshStandardMaterial({ map: tile(concreteTexture("#d4cfc4", "#2bb6b8"), W / 30, 1.4), roughness: 0.9 }));
  back.position.set(xm, HOLE_BOTTOM + Hh / 2, -16); back.receiveShadow = true; root.add(back);
  // end walls with the tunnel opening (a half disc cut out)
  for (const x of [ST0, ST1]) {
    const s = new THREE.Shape();
    s.moveTo(0, HOLE_BOTTOM); s.lineTo(16, HOLE_BOTTOM); s.lineTo(16, STATION_TOP); s.lineTo(0, STATION_TOP); s.lineTo(0, YA + LIN_I);
    s.absarc(0, YA, LIN_I, Math.PI / 2, -Math.PI / 2, true); s.lineTo(0, HOLE_BOTTOM);
    const m = new THREE.Mesh(new THREE.ShapeGeometry(s), std("#cfcabf", { map: tile(concreteTexture(), 3, 1), side: THREE.DoubleSide, roughness: 0.9 }));
    m.rotation.y = Math.PI / 2; m.position.x = x; m.receiveShadow = true; root.add(m);
  }
  // floor and ceiling slabs
  box(W, 1.85, 16, conc, xm, HOLE_BOTTOM + 0.925, -8, root);
  box(W, 1.2, 16, conc, xm, STATION_TOP - 0.6, -8, root);
  // platform + safety line
  const PX0 = ST0 + 3, PX1 = ST1 - 3;
  box(PX1 - PX0, 0.75, 9.3, std("#d9d6cf", { roughness: 0.8 }), (PX0 + PX1) / 2, RAIL_Y + 0.375, -7.85, root);
  box(PX1 - PX0, 0.03, 0.35, std("#f7c52f", { emissive: new THREE.Color("#f7c52f"), emissiveIntensity: 0.4 }), (PX0 + PX1) / 2, RAIL_Y + 0.77, -3.5, root);
  // columns and light panels
  const lamp = std("#fffbe8", { emissive: new THREE.Color("#fff4d0"), emissiveIntensity: 2.6 });
  for (let i = 0; i < 4; i++) {
    const x = ST0 + 6 + i * ((W - 12) / 3);
    box(1.1, STATION_TOP - 1.2 - (RAIL_Y + 0.75), 1.1, conc, x, (STATION_TOP - 1.2 + RAIL_Y + 0.75) / 2, -5.2, root);
    box(2.4, 0.25, 0.3, lamp, x + 4.2, STATION_TOP - 1.3, -2.0, root);
    box(2.4, 0.25, 0.3, lamp, x + 4.2, STATION_TOP - 1.3, -9.5, root);
  }
  // station name panels on the back wall
  for (const x of [ST0 + 9, xm, ST1 - 9]) {
    const sg = new THREE.Mesh(new THREE.PlaneGeometry(7.6, 1.9), new THREE.MeshBasicMaterial({ map: signTexture("CENTRAL", "#1d7f86"), toneMapped: false }));
    sg.position.set(x, -9.0, -15.95); root.add(sg);
  }
  // props on the platform: model, x, z, scale, yaw
  const put = (key: keyof typeof TUNNEL_MODELS, x: number, z: number, s: number, ry: number, size: number, height = false) => {
    const m = models.get(TUNNEL_MODELS[key], { size, height });
    m.position.set(x, RAIL_Y + 0.75, z); m.scale.multiplyScalar(s); m.rotation.y = ry; root.add(m);
  };
  put("worker", xm - 10, -8.5, 1.5, 0.3, 1.75, true); put("man", xm + 6, -10.4, 1.5, -0.6, 1.75, true); put("woman", xm + 12, -6.5, 1.5, 2.2, 1.75, true);
  put("cone", xm - 3, -4.4, 1.4, 0, 0.7, true); put("cone", xm + 1.5, -4.4, 1.4, 0, 0.7, true);
  put("barrier", xm - 14, -5.0, 1.6, 0, 1.2, true); put("barrier", xm + 15, -5.0, 1.6, 0, 1.2, true);
  put("container", ST1 - 7, -13.0, 0.9, 0, 6);
  return root;
}
