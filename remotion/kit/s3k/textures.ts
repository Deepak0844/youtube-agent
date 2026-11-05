// Canvas-drawn textures (no image files): strata, pebbles, sand, paving, concrete, ripples, signs, sprites.
// Rules that make them look right: every colour map is sRGB, ground maps use RepeatWrapping with UVs aligned to WORLD metres
// (so a pebble is the same size everywhere), and each texture is made once (cached by its key) because drawing costs time.
// They need a browser canvas (`document`), so they are built inside the render, never in a unit test.
import * as THREE from "three";
import { rnd } from "./rng";

type Rng = () => number;
const mk = (w: number, h: number): HTMLCanvasElement => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
const ctx2d = (c: HTMLCanvasElement): CanvasRenderingContext2D => c.getContext("2d")!;
/** Canvas -> colour texture (sRGB). `rep` > 0 turns on RepeatWrapping. */
export const toTexture = (c: HTMLCanvasElement, rep?: [number, number]): THREE.CanvasTexture => {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (rep) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rep[0], rep[1]); }
  return t;
};
const cache = new Map<string, THREE.Texture>();
const once = <T extends THREE.Texture>(key: string, make: () => T): T => { let t = cache.get(key); if (!t) { t = make(); cache.set(key, t); } return t as T; };

function grain(g: CanvasRenderingContext2D, w: number, h: number, r: Rng, amt: number, n: number): void {
  for (let i = 0; i < n; i++) {
    const v = r() < 0.5 ? 0 : 255;
    g.fillStyle = `rgba(${v},${v},${v},${r() * amt})`;
    g.fillRect(r() * w, r() * h, 1 + r() * 2, 1 + r() * 2);
  }
}

/** Round stones with a soft highlight, wrapped at the edges so the tile repeats without a seam. */
function stones(g: CanvasRenderingContext2D, w: number, h: number, r: Rng, n: number, rmin: number, rmax: number, pal: readonly string[], alpha = 1): void {
  for (let i = 0; i < n; i++) {
    const x = r() * w, y = r() * h, rad = rmin + r() * (rmax - rmin);
    const col = pal[Math.floor(r() * pal.length)]!;
    for (const dx of [-w, 0, w]) for (const dy of [-h, 0, h]) {
      const X = x + dx, Y = y + dy;
      if (X < -rad || X > w + rad || Y < -rad || Y > h + rad) continue;
      const gr = g.createRadialGradient(X - rad * 0.3, Y - rad * 0.35, rad * 0.1, X, Y, rad);
      gr.addColorStop(0, "#ffffff30"); gr.addColorStop(0.4, col); gr.addColorStop(1, "#00000044");
      g.globalAlpha = alpha;
      g.fillStyle = gr;
      g.beginPath(); g.ellipse(X, Y, rad, rad * (0.7 + r() * 0.25), r() * 3, 0, Math.PI * 2); g.fill();
      g.globalAlpha = 1;
    }
  }
}

// ---------------- strata (cut-face layers) ----------------
/** One soil layer: colour, relative thickness, and whether it is a gravel/pebble layer. */
export type Layer = { color: string; h: number; /** Stones in this layer: true = a normal scatter, or { count, rmin, rmax } (stone radius in texture pixels) for a denser or coarser gravel. */ pebbles?: boolean | { count?: number; rmin?: number; rmax?: number } };
/** The proof's sand, clay and gravel sequence (top to bottom). */
export const STRATA_DEFAULT: readonly Layer[] = [
  { color: "#ecd9ae", h: 0.9, pebbles: { count: 700, rmin: 2, rmax: 6 } }, { color: "#d9bd88", h: 0.5, pebbles: true }, { color: "#a8693f", h: 1.1 }, { color: "#d6c7b0", h: 1.3 }, { color: "#8e6446", h: 0.8, pebbles: true },
  { color: "#e3d6c0", h: 1.3 }, { color: "#a9805f", h: 0.9 }, { color: "#d8ccb8", h: 1.4 }, { color: "#7d5c46", h: 0.8, pebbles: true }, { color: "#cdbda5", h: 1.3 }, { color: "#a37a58", h: 0.9 }, { color: "#dcd0bb", h: 1.1 },
];
/** Lower edge of every layer as a fraction 0..1 of the tile height (top = 0). Pure. */
export function layerEdges(layers: readonly Layer[]): number[] {
  const tot = layers.reduce((s, l) => s + l.h, 0) || 1;
  let acc = 0;
  return layers.map((l) => (acc += l.h / tot));
}

/** One tile of layered ground: coloured bands with gently wavy edges (the wave repeats exactly across the tile), grain, and pebbles in gravel layers. */
export function strataTexture(layersIn: readonly Layer[] = STRATA_DEFAULT, seed = 11): THREE.CanvasTexture {
  const layers = layersIn.slice(0, 32); // a scene cannot ask for thousands of bands
  const key = `strata:${seed}:${layers.map((l) => `${l.color}${l.h}${JSON.stringify(l.pebbles ?? 0)}`).join(",")}`;
  return once(key, () => {
    const W = 1024, H = 1024, c = mk(W, H), g = ctx2d(c), r = rnd(seed);
    g.fillStyle = "#ccb99c"; g.fillRect(0, 0, W, H);
    const k1 = (2 * Math.PI * 12) / W, k2 = (2 * Math.PI * 50) / W; // whole waves per tile: the tile joins itself
    const edge = (x: number, y: number) => y + Math.sin(x * k1 + y) * 3 + Math.sin(x * k2 + y * 2) * 1.5;
    const fr = layerEdges(layers);
    let y0 = 0;
    layers.forEach((l, i) => {
      const y1 = fr[i]! * H;
      g.fillStyle = l.color;
      g.beginPath(); g.moveTo(0, edge(0, y0));
      for (let x = 0; x <= W; x += 16) g.lineTo(x, edge(x, y0));
      for (let x = W; x >= 0; x -= 16) g.lineTo(x, edge(x, y1));
      g.closePath(); g.fill();
      const gr = g.createLinearGradient(0, y0, 0, y1); gr.addColorStop(0, "#ffffff22"); gr.addColorStop(0.5, "#00000000"); gr.addColorStop(1, "#00000026");
      g.fillStyle = gr; g.fillRect(0, y0, W, y1 - y0);
      if (l.pebbles) {
        const pc = typeof l.pebbles === "object" ? l.pebbles : {};
        g.save(); g.beginPath(); g.rect(0, y0, W, y1 - y0); g.clip(); g.translate(0, y0);
        stones(g, W, y1 - y0, r, Math.min(5000, Math.max(0, pc.count ?? 300)), pc.rmin ?? 1.6, pc.rmax ?? 5.5, ["#cdbba0", "#8a7863", "#e0d2bb", "#a0694a", "#6f6a62"], 0.95);
        g.restore();
      }
      y0 = y1;
    });
    grain(g, W, H, r, 0.18, 24000);
    return toTexture(c);
  });
}

/** Big river stones tile (gravel bank, rubble, breakwater). rep = repeats on the mesh. */
export function pebbleTexture(rep: [number, number] = [1, 1]): THREE.CanvasTexture {
  const t = once(`pebble`, () => {
    const W = 1024, H = 1024, c = mk(W, H), g = ctx2d(c), r = rnd(5);
    g.fillStyle = "#8f7d6d"; g.fillRect(0, 0, W, H);
    const pal = ["#b9a58d", "#8d7b6a", "#cbbca7", "#a98068", "#7a746d", "#d3c5ae", "#9c8571", "#b99a80", "#9a948a"];
    const placed: [number, number, number][] = [];
    for (let i = 0; i < 40000 && placed.length < 520; i++) {
      const rad = 16 + r() * 26, x = r() * W, y = r() * H;
      if (placed.some(([px, py, pr]) => { let dx = Math.abs(px - x), dy = Math.abs(py - y); dx = Math.min(dx, W - dx); dy = Math.min(dy, H - dy); return Math.hypot(dx, dy) < (pr + rad) * 0.86; })) continue;
      placed.push([x, y, rad]);
    }
    placed.forEach(([x, y, rad]) => {
      const col = pal[Math.floor(r() * pal.length)]!;
      for (const dx of [-W, 0, W]) for (const dy of [-H, 0, H]) {
        const X = x + dx, Y = y + dy;
        if (X < -rad || X > W + rad || Y < -rad || Y > H + rad) continue;
        const gr = g.createRadialGradient(X - rad * 0.3, Y - rad * 0.35, rad * 0.1, X, Y, rad);
        gr.addColorStop(0, "#ffffff66"); gr.addColorStop(0.4, col); gr.addColorStop(1, "#00000044");
        g.fillStyle = gr; g.beginPath(); g.ellipse(X, Y, rad, rad * (0.75 + r() * 0.2), r() * 3, 0, Math.PI * 2); g.fill();
      }
    });
    grain(g, W, H, r, 0.15, 12000);
    return toTexture(c);
  });
  const o = t.clone(); o.needsUpdate = true; o.wrapS = o.wrapT = THREE.RepeatWrapping; o.repeat.set(rep[0], rep[1]);
  return o;
}

/** Sand with soft ripples and a few stones. */
export function sandTexture(base = "#e6d3a8"): THREE.CanvasTexture {
  return once(`sand:${base}`, () => {
    const W = 512, H = 512, c = mk(W, H), g = ctx2d(c), r = rnd(3);
    g.fillStyle = base; g.fillRect(0, 0, W, H);
    for (let i = 0; i < 40; i++) {
      g.strokeStyle = `rgba(160,120,70,${0.04 + r() * 0.05})`; g.lineWidth = 2 + r() * 4;
      g.beginPath(); const y = r() * H; g.moveTo(0, y);
      for (let x = 0; x <= W; x += 32) g.lineTo(x, y + Math.sin(x * 0.02 + i) * 6);
      g.stroke();
    }
    grain(g, W, H, r, 0.3, 30000);
    stones(g, W, H, r, 60, 1.5, 4, ["#c9b79c", "#8d7b66", "#d8cab4"], 0.8);
    const t = toTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
  });
}

/** Bump map of small ripples for water (grey = flat). */
export function rippleTexture(): THREE.CanvasTexture {
  return once("ripple", () => {
    const W = 512, H = 512, c = mk(W, H), g = ctx2d(c), r = rnd(9);
    g.fillStyle = "#808080"; g.fillRect(0, 0, W, H);
    for (let i = 0; i < 700; i++) {
      const x = r() * W, y = r() * H, rr = 6 + r() * 26, v = r() < 0.5 ? 255 : 0;
      const gr = g.createRadialGradient(x, y, 0, x, y, rr); gr.addColorStop(0, `rgba(${v},${v},${v},0.25)`); gr.addColorStop(1, "rgba(128,128,128,0)");
      g.fillStyle = gr; g.fillRect(x - rr, y - rr, rr * 2, rr * 2);
    }
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
  });
}

/** Light paving slabs with joints. */
export function paveTexture(base = "#e2ddd0"): THREE.CanvasTexture {
  return once(`pave:${base}`, () => {
    const W = 256, H = 256, c = mk(W, H), g = ctx2d(c), r = rnd(41);
    g.fillStyle = base; g.fillRect(0, 0, W, H); grain(g, W, H, r, 0.14, 6000);
    g.strokeStyle = "rgba(90,80,65,0.35)"; g.lineWidth = 2;
    for (let i = 0; i <= 4; i++) { g.beginPath(); g.moveTo(0, i * 64); g.lineTo(W, i * 64); g.stroke(); g.beginPath(); g.moveTo(i * 64, 0); g.lineTo(i * 64, H); g.stroke(); }
    const t = toTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
  });
}
/** Road asphalt with a dashed centre line and edge lines (tile = 16 m along x, 7.5 m across). */
export function asphaltTexture(): THREE.CanvasTexture {
  return once("asphalt", () => {
    const W = 512, H = 256, c = mk(W, H), g = ctx2d(c), r = rnd(31);
    g.fillStyle = "#4a4f58"; g.fillRect(0, 0, W, H); grain(g, W, H, r, 0.22, 26000);
    g.fillStyle = "#e9eef2";
    for (let x = 0; x < W; x += 256) g.fillRect(x + 20, H / 2 - 3, 120, 6);
    g.fillRect(0, 10, W, 4); g.fillRect(0, H - 14, W, 4);
    const t = toTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
  });
}
/** Poured concrete with panel joints; `band` paints a coloured stripe (station wall). */
export function concreteTexture(base = "#cfcac0", band?: string): THREE.CanvasTexture {
  return once(`concrete:${base}:${band ?? ""}`, () => {
    const W = 512, H = 512, c = mk(W, H), g = ctx2d(c), r = rnd(51);
    g.fillStyle = base; g.fillRect(0, 0, W, H);
    for (let i = 0; i < 60; i++) { g.fillStyle = `rgba(90,85,75,${0.02 + r() * 0.04})`; g.fillRect(r() * W, r() * H, 30 + r() * 120, 20 + r() * 80); }
    grain(g, W, H, r, 0.16, 16000);
    g.strokeStyle = "rgba(60,55,50,0.35)"; g.lineWidth = 3;
    for (let i = 0; i <= 4; i++) { g.beginPath(); g.moveTo(0, i * 128); g.lineTo(W, i * 128); g.stroke(); }
    for (let i = 0; i <= 2; i++) { g.beginPath(); g.moveTo(i * 256, 0); g.lineTo(i * 256, H); g.stroke(); }
    if (band) { g.fillStyle = band; g.fillRect(0, 128 * 2 + 6, W, 120); g.fillStyle = "#ffffff55"; g.fillRect(0, 128 * 2 + 6, W, 8); }
    const t = toTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
  });
}
/** Conveyor belt cleats; scroll it with texture.offset.x = -t * speed. */
export function beltTexture(): THREE.CanvasTexture {
  return once("belt", () => {
    const c = mk(64, 64), g = ctx2d(c);
    g.fillStyle = "#2a2d33"; g.fillRect(0, 0, 64, 64);
    g.fillStyle = "#4a4f5a"; for (let x = 0; x < 64; x += 16) g.fillRect(x, 0, 4, 64);
    const t = toTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4; return t;
  });
}
/** Station / shop sign: bold text on a flat colour. Use with a MeshBasicMaterial (toneMapped:false) so it stays crisp. */
export function signTexture(textIn: string, bg = "#1f8f93", fg = "#ffffff"): THREE.CanvasTexture {
  const text = String(textIn).slice(0, 60);
  return once(`sign:${text}:${bg}:${fg}`, () => {
    const W = 512, H = 128, c = mk(W, H), g = ctx2d(c);
    g.fillStyle = bg; g.fillRect(0, 0, W, H); g.fillStyle = "#ffffff22"; g.fillRect(0, 0, W, 10);
    g.fillStyle = fg; g.font = "900 78px Arial, Helvetica, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(text, W / 2, H / 2 + 4);
    return toTexture(c);
  });
}
/** Soft round dot for dust, spray and smoke particles. */
export function dustSprite(): THREE.CanvasTexture {
  return once("dust", () => {
    const c = mk(64, 64), g = ctx2d(c);
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, "rgba(255,255,255,0.9)"); gr.addColorStop(0.5, "rgba(255,255,255,0.35)"); gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  });
}
/** Vertical colour ramp (water behind glass: light at the top, deep at the bottom). */
export function glassWaterTexture(): THREE.CanvasTexture {
  return once("glasswater", () => {
    const c = mk(4, 256), g = ctx2d(c);
    const gr = g.createLinearGradient(0, 0, 0, 256); gr.addColorStop(0, "#7fe3e2"); gr.addColorStop(0.5, "#1fa6c9"); gr.addColorStop(1, "#0a4f9c");
    g.fillStyle = gr; g.fillRect(0, 0, 4, 256);
    return toTexture(c);
  });
}
