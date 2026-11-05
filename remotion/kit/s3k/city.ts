// City pieces: glass towers with facade textures that keep their window size on any tower, a far skyline of cheap boxes, and a
// hero tower with roof details. A tower is a BoxGeometry whose UVs are scaled in metres, so a window is the same size on a 20 m and a
// 200 m tower (the proof's `tower`). Far skyline towers do not cast shadows and share five materials: 90 towers cost five textures.
import * as THREE from "three";
import { toTexture } from "./textures";
import { rnd } from "./rng";
import { std, steel } from "./parts";

const mk = (w: number, h: number): HTMLCanvasElement => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
const cache = new Map<number, THREE.CanvasTexture>();

/** Glass facade tile: bands of blue glass with pale mullions (kind 0..4 = five colour families). */
export function facadeTexture(kind: number): THREE.CanvasTexture {
  const k = ((kind % 5) + 5) % 5;
  let t = cache.get(k);
  if (!t) {
    const W = 256, H = 256, c = mk(W, H), g = c.getContext("2d")!, r = rnd(20 + k);
    const pals = [["#e6eef5", "#a6bfd6"], ["#f4f7f9", "#b4c9de"], ["#c9d8e4", "#7fa3c0"], ["#eef2f4", "#9bb8cf"], ["#d8e3ea", "#8fb0c8"]];
    const [a, b] = pals[k]!;
    g.fillStyle = a!; g.fillRect(0, 0, W, H);
    const rows = 8 + (k % 3) * 2;
    for (let i = 0; i < rows; i++) {
      const y = (i / rows) * H, gr = g.createLinearGradient(0, y, 0, y + H / rows); gr.addColorStop(0, b!); gr.addColorStop(1, "#7295b3");
      g.fillStyle = gr; g.fillRect(0, y + 3, W, (H / rows) * 0.62);
    }
    if (k % 2) { g.fillStyle = "#ffffff66"; for (let x = 0; x < W; x += 32) g.fillRect(x, 0, 3, H); }
    for (let i = 0; i < 3000; i++) { const v = r() < 0.5 ? 0 : 255; g.fillStyle = `rgba(${v},${v},${v},${r() * 0.1})`; g.fillRect(r() * W, r() * H, 1 + r() * 2, 1 + r() * 2); }
    t = toTexture(c, [1, 1]);
    cache.set(k, t);
  }
  return t;
}

/** Box w x h x d whose UVs are in metres (one facade tile = 14 m wide, 13 m tall): windows keep their size. */
export function tower(w: number, h: number, d: number): THREE.BoxGeometry {
  const geo = new THREE.BoxGeometry(w, h, d);
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let f = 0; f < 6; f++) for (let i = 0; i < 4; i++) {
    const k = f * 4 + i, u = uv.getX(k), v = uv.getY(k);
    const horiz = f < 2 ? d : w; // faces +x,-x are d wide; the rest w wide
    uv.setXY(k, (u * horiz) / 14, f >= 2 && f < 4 ? (v * d) / 14 : (v * h) / 13);
  }
  return geo;
}

const tileMat = (k: number, rough: number, metal: number, env: number): THREE.MeshStandardMaterial => {
  const m = facadeTexture(k).clone(); m.needsUpdate = true; m.wrapS = m.wrapT = THREE.RepeatWrapping;
  return new THREE.MeshStandardMaterial({ map: m, roughness: rough, metalness: metal, envMapIntensity: env });
};

/** Five facade materials for near towers (glossier) and for the far skyline (flat). */
export const towerMaterials = (far = false): THREE.MeshStandardMaterial[] => [0, 1, 2, 3, 4].map((k) => (far ? tileMat(k, 0.55, 0.05, 0.8) : tileMat(k, 0.4, 0.15, 1.0)));

/** A hero tower: the shaft, a smaller crown, and a spire (k % 3 === 0) or a dome (k % 3 === 1). Base on y = 0 at (x, z). */
export function glassTower(mats: THREE.MeshStandardMaterial[], w: number, h: number, d: number, k: number, x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  const m = new THREE.Mesh(tower(w, h, d), mats[k % 5]!); m.position.set(0, h / 2, 0); m.castShadow = m.receiveShadow = true; g.add(m);
  const h2 = h * 0.16, m2 = new THREE.Mesh(tower(w * 0.7, h2, d * 0.7), mats[(k + 1) % 5]!); m2.position.set(0, h + h2 / 2, 0); m2.castShadow = true; g.add(m2);
  if (k % 3 === 0) { const sp = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.5, 9, 8), steel("#cfd6dc")); sp.position.set(0, h + h2 + 4.5, 0); g.add(sp); }
  if (k % 3 === 1) { const dm = new THREE.Mesh(new THREE.SphereGeometry(w * 0.3, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: "#3fb7bb", roughness: 0.3, metalness: 0.3 })); dm.position.set(0, h + h2, 0); g.add(dm); }
  g.position.set(x, 0, z);
  return g;
}

export type FarSkylineOptions = { seed?: number; count?: number; /** x range centre and width (default 0, 900). */ x?: number; width?: number; /** Nearest and farthest z (negative). Default -150, -600. */ zNear?: number; zFar?: number; groundY?: number };
/** A ring of cheap towers on the horizon, base on groundY. Cast no shadows (they are far and mostly in haze). */
export function farSkyline(o: FarSkylineOptions = {}): THREE.Group {
  const g = new THREE.Group(), r = rnd(o.seed ?? 5), mats = towerMaterials(true);
  const gy = o.groundY ?? 0, zN = o.zNear ?? -150, zF = o.zFar ?? -600, cx = o.x ?? 0, wd = o.width ?? 900;
  for (let i = 0; i < (o.count ?? 90); i++) {
    const w = 14 + r() * 26, d = 14 + r() * 26, h = 40 + Math.pow(r(), 1.6) * 190;
    const x = cx + (r() - 0.5) * wd, z = zN + r() * (zF - zN), k = Math.floor(r() * 5);
    const m = new THREE.Mesh(tower(w, h, d), mats[k]!); m.position.set(x, gy + h / 2, z); g.add(m);
    if (r() < 0.35) { const cap = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.18, w * 0.3, 7, 12), std("#9fb4c6")); cap.position.set(x, gy + h + 3.5, z); g.add(cap); }
  }
  return g;
}
