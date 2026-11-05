// HERO EXAMPLE 1: a tunnel boring machine, cut in half so you see inside. Not magic: boxes, cylinders, ring sectors and a few loops.
// WHAT TO COPY
//  - Build once in a function, return { root, update(t) }. update is a pure function of t: the cutter angle, the belt, the erector
//    arm and the dust are all computed from t, never from the previous frame.
//  - Everything hangs on ONE group placed at the tunnel axis (root.position.y = YA); parts are positioned relative to it.
//  - Detail that reads on a phone: a big recognisable silhouette (orange shield, six-spoke cutter), few bright accent colours
//    (yellow, blue, steel), a moving belt with rocks on it, dust drifting. Tiny parts (bolts) are skipped.
//  - The half-pipe pieces use `sector()` (a ring wedge): the machine is open towards +z so the camera sees inside it.
import * as THREE from "three";
import { beltTexture } from "../textures";
import { between, box, cyl, ring, sector, std, steel } from "../parts";
import { makeParticles } from "../particles";
import { rnd } from "../rng";
import { LIN_I, LIN_O, RAIL_Y, RAIL_Z, RING_GAP, RING_LEN, SH_I, SH_O, YA } from "./dims";

const ORANGE = "#f0651b", YEL = "#f7c52f", DARK = "#343a45", GREY = "#aebfcd", SILVER = "#d3dbe2", BLUE = "#2f6db5";
// the lining ring is 5 segments of 32 degrees each, centred 36 degrees apart
const SEG_C = [-72, -36, 0, 36, 72].map((d) => (d * Math.PI) / 180);
const SEG_HALF = (16 * Math.PI) / 180;
/** Geometry of lining segment j (0..4): used by the machine's erector and by the finished tunnel (lining.ts). */
export const liningSegment = (j: number): THREE.ExtrudeGeometry => sector(LIN_O, LIN_I, SEG_C[j]! - SEG_HALF, SEG_C[j]! + SEG_HALF, RING_LEN - RING_GAP);

export type Machine = { root: THREE.Group; update: (t: number) => void };

export function buildMachine(): Machine {
  const root = new THREE.Group();
  root.position.y = YA;
  const orange = steel(ORANGE, 0.45), dark = steel(DARK, 0.5), silver = steel(SILVER, 0.25), yel = std(YEL, { roughness: 0.5 }), grey = steel(GREY, 0.5), blue = steel(BLUE, 0.4);
  const pie = Math.PI / 2;

  // ---- shield skin (a half pipe, cut open towards the viewer) + collars ----
  const skin = new THREE.Mesh(sector(SH_O, SH_I, -pie, pie, 9), orange);
  skin.position.x = -9.5; skin.castShadow = skin.receiveShadow = true; root.add(skin);
  const collarF = new THREE.Mesh(sector(SH_O + 0.02, SH_I - 0.35, -pie, pie, 0.7), dark); collarF.position.x = -1.2; root.add(collarF);
  const collarR = new THREE.Mesh(sector(SH_O + 0.02, SH_I - 0.05, -pie, pie, 0.55), yel); collarR.position.x = -9.5; root.add(collarR);
  const band = new THREE.Mesh(sector(SH_O + 0.02, SH_I - 0.05, -pie, pie, 0.5), yel); band.position.x = -5.4; root.add(band);
  // bulkhead (pressure wall) with a central opening, the main bearing and ring of drive motors
  const bulk = new THREE.Mesh(sector(SH_I, 1.2, -pie, pie, 0.45), grey); bulk.position.x = -2.65; root.add(bulk);
  cyl(1.35, 1.35, 1.6, steel("#7f8fa0", 0.35), "x", -2.2, 0, 0, root);
  for (let i = -3; i <= 3; i++) {
    const a = (i * 24 * Math.PI) / 180, r = 2.55, y = r * Math.sin(a), z = -r * Math.cos(a);
    cyl(0.5, 0.5, 2.6, blue, "x", -4.2, y, z, root);
    cyl(0.56, 0.56, 0.22, silver, "x", -2.95, y, z, root);
    cyl(0.3, 0.3, 0.5, dark, "x", -5.7, y, z, root);
  }
  // screw conveyor lifting the muck out of the chamber onto the belt
  const sc0 = new THREE.Vector3(-2.3, -2.9, -1.5), sc1 = new THREE.Vector3(-8.2, -0.5, -1.5);
  between(sc0, sc1, 0.6, std("#e0a928", { metalness: 0.4, roughness: 0.4 }), root, 18);
  between(sc0.clone().add(new THREE.Vector3(0.2, -0.08, 0)), sc1, 0.25, dark, root, 10);
  // grippers: pistons pressing steel pads on the tunnel wall, top and bottom
  for (const s of [1, -1]) for (const dz of [-0.8, -2.2]) {
    cyl(0.3, 0.3, 1.3, silver, "y", -6.8, s * 3.05, dz, root);
    cyl(0.18, 0.18, 0.6, steel("#889", 0.3), "y", -6.8, s * 3.75, dz, root);
    box(2.3, 0.22, 1.1, dark, -6.8, s * 3.98, dz, root);
  }
  // thrust cylinders pushing against the last lining ring
  for (let i = -4; i <= 4; i++) {
    const a = (i * 19 * Math.PI) / 180, r = 3.25, y = r * Math.sin(a), z = -r * Math.cos(a);
    cyl(0.28, 0.28, 1.4, steel("#e9eef2", 0.3), "x", -6.7, y, z, root);
    cyl(0.14, 0.14, 0.9, silver, "x", -7.0, y, z, root);
    cyl(0.32, 0.32, 0.12, dark, "x", -7.45, y, z, root);
  }

  // ---- cutter head: a rim, a hub and six spokes carrying disc cutters. It is NOT cut in half: the whole wheel is seen turning ----
  const cutter = new THREE.Group(); root.add(cutter);
  const rim = new THREE.Mesh(ring(4.33, 3.75, 1.15), dark); rim.position.x = -1.0; cutter.add(rim);
  const back = new THREE.Mesh(new THREE.CylinderGeometry(4.0, 4.0, 0.1, 48).rotateZ(Math.PI / 2), std("#17130f", { roughness: 0.9 })); back.position.x = -0.95; cutter.add(back);
  cyl(1.2, 1.3, 1.15, dark, "x", -0.5, 0, 0, cutter);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(1.0, 0.7, 24).rotateZ(-Math.PI / 2), orange); nose.position.set(0.28, 0, 0); cutter.add(nose);
  for (let k = 0; k < 6; k++) {
    const sp = new THREE.Group(); sp.rotation.x = (k * Math.PI) / 3; cutter.add(sp);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.85, 3.2, 1.15), orange); bar.position.set(-0.5, 2.55, 0); bar.castShadow = true; sp.add(bar);
    for (let i = 0; i < 5; i++) {
      const r = 1.35 + i * 0.7;
      for (const dz of [-0.42, 0.42]) { // a pair of disc cutters per station
        cyl(0.3, 0.3, 0.14, silver, "z", 0.06, r, dz, sp, 20);
        cyl(0.13, 0.13, 0.2, dark, "z", 0.06, r, dz, sp, 10);
      }
    }
    cyl(0.34, 0.34, 0.16, silver, "z", 0.0, 4.2, 0, sp, 20); // gauge cutter on the rim
    for (const dz of [-0.45, 0.45]) { const tooth = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.38, 6).rotateZ(-Math.PI / 2), std(YEL)); tooth.position.set(0.25, 3.9, dz); sp.add(tooth); }
    const bar2 = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.55, 2.0), orange); bar2.position.set(-0.45, 4.0, 0); sp.add(bar2);
  }

  // ---- erector: an arm that picks lining segments and places them, cycle of 8 s, five segments per ring ----
  const erector = new THREE.Group(); erector.position.x = -8.2; root.add(erector);
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.4, 3.0, 0.4), yel); arm.position.y = 1.7; arm.castShadow = true; erector.add(arm);
  const pad = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.35, 0.5), dark); pad.position.y = 3.25; pad.castShadow = true; erector.add(pad);
  cyl(0.55, 0.55, 1.2, steel("#6c7a8a", 0.4), "x", 0, 0, 0, erector);
  const segMat = std("#d9d4c9", { roughness: 0.85, metalness: 0 });
  const placed: THREE.Mesh[] = [], carried: THREE.Mesh[] = [];
  for (let j = 0; j < 5; j++) {
    const m = new THREE.Mesh(liningSegment(j), segMat.clone()); m.position.x = -9.0; m.castShadow = m.receiveShadow = true; root.add(m); placed.push(m);
    const c = new THREE.Mesh(liningSegment(j), segMat.clone()); c.position.x = -9.0; c.castShadow = true; root.add(c); carried.push(c);
  }

  // ---- back-up gantry: two trailers + two muck skips on the rails ----
  const frame = steel("#bcc9d5", 0.5);
  const trailer = (x0: number, x1: number, k: number) => {
    const xm = (x0 + x1) / 2, L = x1 - x0;
    box(L, 0.22, 3.4, frame, xm, -1.5, -1.5, root); // lower deck
    box(L, 0.2, 3.1, frame, xm, 1.3, -1.6, root); // upper deck
    box(L, 0.1, 3.4, std("#566", { roughness: 0.8 }), xm, -1.37, -1.5, root);
    for (const x of [x0 + 0.2, x1 - 0.2]) for (const z of [0.0, -3.0]) between(new THREE.Vector3(x, -1.5, z), new THREE.Vector3(x, 1.3, z * 0.95 - 0.1), 0.11, yel, root, 8);
    between(new THREE.Vector3(x0 + 0.2, -1.4, 0.0), new THREE.Vector3(x1 - 0.2, 1.2, 0.0), 0.06, yel, root, 6); // diagonal braces on the open side
    between(new THREE.Vector3(x1 - 0.2, -1.4, 0.0), new THREE.Vector3(x0 + 0.2, 1.2, 0.0), 0.06, yel, root, 6);
    box(L, 0.07, 0.07, yel, xm, 2.35, 0.05, root); // hand rail
    for (let x = x0 + 0.3; x <= x1; x += 1.05) box(0.07, 1.0, 0.07, yel, x, 1.85, 0.05, root);
    for (const x of [x0 + 0.9, x1 - 0.9]) for (const z of RAIL_Z) cyl(0.5, 0.5, 0.22, dark, "z", x, RAIL_Y - YA + 0.5, z, root, 20);
    box(L - 1.2, 0.18, 2.4, dark, xm, -1.85, -1.0, root);
    if (k === 0) { // equipment makes the deck read as "machinery"
      box(2.2, 1.3, 1.4, yel, xm - 1.6, 2.05, -1.9, root);
      cyl(0.55, 0.55, 0.9, steel("#c0392b", 0.5), "z", xm + 1.3, 1.95, -2.3, root);
      box(1.6, 0.9, 1.0, blue, xm + 1.8, -0.8, -2.2, root);
    } else {
      box(1.6, 1.1, 1.3, blue, xm - 1.2, 1.95, -2.0, root);
      cyl(0.5, 0.5, 1.4, steel("#e9eef2", 0.3), "x", xm + 1.0, 1.95, -2.2, root);
      box(2.0, 0.8, 1.2, yel, xm + 1.4, -0.9, -2.2, root);
    }
    box(L - 1.0, 0.07, 0.25, std("#fff8e6", { emissive: new THREE.Color("#fff2c8"), emissiveIntensity: 2.2 }), xm, 1.17, -0.4, root); // light bar
  };
  trailer(-16.2, -9.6, 0); trailer(-22.9, -16.5, 1);
  const skipMat = steel("#c64a2b", 0.5);
  for (const [x0, x1] of [[-26.9, -23.4], [-30.7, -27.2]] as [number, number][]) {
    const xm = (x0 + x1) / 2;
    box(x1 - x0, 0.2, 2.3, dark, xm, -1.85, -1.0, root);
    box(x1 - x0, 1.0, 0.14, skipMat, xm, -1.15, -2.15, root); box(x1 - x0, 1.0, 0.14, skipMat, xm, -1.15, 0.15, root);
    box(0.14, 1.0, 2.3, skipMat, x0, -1.15, -1.0, root); box(0.14, 1.0, 2.3, skipMat, x1, -1.15, -1.0, root);
    const pile = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8), std("#7b5a3e", { roughness: 1 })); pile.scale.set((x1 - x0) * 0.46, 0.55, 0.95); pile.position.set(xm, -0.95, -1.0); pile.castShadow = true; root.add(pile);
    for (const z of RAIL_Z) { cyl(0.35, 0.35, 0.2, dark, "z", xm - 1.0, -2.0, z, root, 14); cyl(0.35, 0.35, 0.2, dark, "z", xm + 1.0, -2.0, z, root, 14); }
  }

  // ---- conveyor belt: two straight boxes, a scrolling cleat texture, and instanced rocks riding along it ----
  const bt = beltTexture().clone(); bt.needsUpdate = true; bt.wrapS = bt.wrapT = THREE.RepeatWrapping;
  const beltMat = new THREE.MeshStandardMaterial({ map: bt, roughness: 0.85, metalness: 0 });
  const sideMat = steel("#58606b", 0.5);
  const path = [new THREE.Vector3(-8.2, -0.4, -1.5), new THREE.Vector3(-12.2, 0.6, -1.5), new THREE.Vector3(-24.2, 0.6, -1.5)];
  const segs: { a: THREE.Vector3; b: THREE.Vector3; len: number }[] = [];
  for (let i = 0; i < 2; i++) {
    const a = path[i]!, b = path[i + 1]!, d = b.clone().sub(a), len = d.length();
    segs.push({ a, b, len });
    const g = new THREE.BoxGeometry(len, 0.12, 1.25);
    const uv = g.attributes.uv as THREE.BufferAttribute;
    for (let k = 8; k < 12; k++) uv.setXY(k, (uv.getX(k) * len) / 1.0, uv.getY(k)); // top face: texture repeats along the belt
    const m = new THREE.Mesh(g, [sideMat, sideMat, beltMat, sideMat, sideMat, sideMat]);
    m.position.copy(a).addScaledVector(d, 0.5); m.rotation.z = Math.atan2(d.y, d.x) + Math.PI; m.castShadow = m.receiveShadow = true; root.add(m);
    for (const z of [-1.5 - 0.7, -1.5 + 0.7]) { const s = new THREE.Mesh(new THREE.BoxGeometry(len, 0.3, 0.07), steel("#e9a31d", 0.5)); s.position.copy(m.position).setZ(z); s.position.y += 0.12; s.rotation.z = m.rotation.z; s.castShadow = true; root.add(s); }
    for (let x = a.x; x > b.x; x -= 3) { const y = a.y + (b.y - a.y) * ((x - a.x) / (b.x - a.x)); between(new THREE.Vector3(x, y - 0.06, -1.5), new THREE.Vector3(x, -1.4, -1.5), 0.07, dark, root, 6); }
  }
  cyl(0.28, 0.28, 1.4, dark, "z", -24.3, 0.6, -1.5, root, 14); // head pulley
  const totalL = segs[0]!.len + segs[1]!.len;
  const rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(0.2, 0), std("#8a6a4a", { roughness: 1 }), 46); rocks.castShadow = true; rocks.frustumCulled = false; root.add(rocks);
  const rr = rnd(7), rseed = Array.from({ length: 46 }, () => ({ o: rr() * totalL, dz: (rr() - 0.5) * 0.8, s: 0.7 + rr() * 1.1, ry: rr() * 6 }));
  const tmp = new THREE.Object3D(), col = new THREE.Color();
  rseed.forEach((_, i) => { col.set(["#8b6b4b", "#6e5640", "#a58562", "#5d4a3a"][i % 4]!); rocks.setColorAt(i, col); });

  // ---- particles: dust drifting in the cutter chamber, and chips thrown off the cutting edge ----
  const dust = makeParticles({
    count: 140, seed: 3, size: 1.5, opacity: 0.55,
    emit: (s, ph, t, out, i) => {
      const ang = s.a + t * 0.25 * (i % 2 ? 1 : -1), r = 0.6 + s.r * 3.1;
      out[0] = -1.9 + Math.sin(ph * 6.28 + s.a) * 0.25 - ph * 0.5;
      out[1] = Math.sin(ang) * r * 0.9 + (0.5 - ph) * 0.4;
      out[2] = -Math.abs(Math.cos(ang) * r) * 0.9;
    },
  });
  const spray = makeParticles({
    count: 120, seed: 9, size: 0.9, color: "#e3c99c", opacity: 0.7,
    emit: (s, ph, _t, out) => { // thrown along the rim, mostly from the lower half, falling as they drift forward
      const rim = 3.2 + s.v * 1.1, a2 = -Math.PI / 2 + Math.sin(s.a) * 1.5;
      out[0] = 0.1 + ph * 1.6 * s.v;
      out[1] = Math.sin(a2) * rim - ph * ph * 2.4 + ph * 0.8;
      out[2] = Math.abs(Math.cos(a2)) * rim * 0.3 + ph * (0.8 + s.v * 2.0);
    },
  });
  root.add(dust.points, spray.points);

  // ---- lamps along the crown ----
  const lampMat = std("#fffbe8", { emissive: new THREE.Color("#fff4d0"), emissiveIntensity: 2.4 });
  for (let x = -26; x > -165; x -= 5) box(1.6, 0.1, 0.3, lampMat, x, 2.55, -2.1, root);

  const point = new THREE.Vector3();
  function update(t: number): void {
    cutter.rotation.x = -t * 0.9;
    bt.offset.x = -t * 0.9; // the belt runs towards the tail
    rseed.forEach((r, i) => { // spoil riding the belt: position along the two segments from t
      const s = (r.o + t * 2.6) % totalL;
      if (s < segs[0]!.len) point.copy(segs[0]!.a).lerp(segs[0]!.b, s / segs[0]!.len); else point.copy(segs[1]!.a).lerp(segs[1]!.b, (s - segs[0]!.len) / segs[1]!.len);
      tmp.position.set(point.x, point.y + 0.16, -1.5 + r.dz * 0.5); tmp.scale.setScalar(r.s); tmp.rotation.set(r.ry, r.ry * 2, 0); tmp.updateMatrix(); rocks.setMatrixAt(i, tmp.matrix);
    });
    rocks.instanceMatrix.needsUpdate = true;
    dust.update(t); spray.update(t);
    // erector builds one ring per 8 s: for each segment j, swing to the pile, carry to its slot, release
    const P = 8, tc = t % P, W = 1.3;
    let armA = SEG_C[0]!, showCarry = -1;
    for (let j = 0; j < 5; j++) {
      const p = tc - 0.3 - j * W;
      const prev = j === 0 ? -pie : SEG_C[j - 1]!;
      if (p >= 0 && p < 0.4) armA = prev + (-pie - prev) * (p / 0.4);
      else if (p >= 0.4 && p < 1.2) { const k = (p - 0.4) / 0.8, e = k * k * (3 - 2 * k); armA = -pie + (SEG_C[j]! + pie) * e; showCarry = j; }
      else if (p >= 1.2) armA = SEG_C[j]!;
    }
    if (tc < 0.3) armA = -pie;
    erector.rotation.x = armA - pie;
    for (let j = 0; j < 5; j++) {
      placed[j]!.visible = tc > 0.3 + j * W + 1.2;
      carried[j]!.visible = showCarry === j;
      if (showCarry === j) carried[j]!.rotation.x = armA - pie - (SEG_C[j]! - pie);
    }
  }
  return { root, update };
}
