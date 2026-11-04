// Procedural canvas textures for the scene3d blocks (everything is drawn in code; nothing is downloaded).
// Reworked from the approved look proof (yt-3d-look-proof/src/tex.ts). Tiles repeat in metres: UV = world metres / tile size.
import * as THREE from "three";

export const rng = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const mk = (w: number, h: number) => {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
};
const toTex = (c: HTMLCanvasElement, repeat = true) => {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
};

function grain(g: CanvasRenderingContext2D, w: number, h: number, r: () => number, amt: number, n: number) {
  for (let i = 0; i < n; i++) {
    const v = r() < 0.5 ? 0 : 255;
    g.fillStyle = `rgba(${v},${v},${v},${r() * amt})`;
    g.fillRect(r() * w, r() * h, 1 + r() * 2, 1 + r() * 2);
  }
}

/** Round shaded stones, drawn with wrap-around copies so the tile repeats. `wrapY` off keeps stones inside a band. */
function pebbles(g: CanvasRenderingContext2D, w: number, h: number, r: () => number, n: number, rmin: number, rmax: number, pal: string[], wrapY = true) {
  for (let i = 0; i < n; i++) {
    const x = r() * w;
    const y = r() * h;
    const rad = rmin + r() * (rmax - rmin);
    const col = pal[Math.floor(r() * pal.length)]!;
    const ry = rad * (0.7 + r() * 0.25);
    const rot = r() * 3;
    for (const dx of [-w, 0, w]) {
      for (const dy of wrapY ? [-h, 0, h] : [0]) {
        const X = x + dx;
        const Y = y + dy;
        if (X < -rad || X > w + rad || Y < -rad || Y > h + rad) continue;
        const gr = g.createRadialGradient(X - rad * 0.3, Y - rad * 0.35, rad * 0.1, X, Y, rad);
        gr.addColorStop(0, "#ffffff66");
        gr.addColorStop(0.4, col);
        gr.addColorStop(1, "#00000055");
        g.fillStyle = gr;
        g.beginPath();
        g.ellipse(X, Y, rad, ry, rot, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
}

export type StrataLayer = { color: string; thickness_m: number; pebbles?: boolean; grain?: number };

/** Layers (top to bottom) of a cross-section. The tile covers exactly the sum of the thicknesses; UV = metres / tileMetres. Edges are wavy and periodic. */
export function strataTile(layers: readonly StrataLayer[], seed = 11, size = 2048) {
  const W = size;
  const H = size;
  const c = mk(W, H);
  const g = c.getContext("2d")!;
  const r = rng(seed);
  const total = layers.reduce((s, l) => s + l.thickness_m, 0);
  const wave = (x: number, y0: number, k: number) => Math.sin((x / W) * Math.PI * 2 * k + y0) * 5 + Math.sin((x / W) * Math.PI * 2 * k * 4 + y0 * 2) * 2.2;
  g.fillStyle = layers[layers.length - 1]!.color;
  g.fillRect(0, 0, W, H);
  let y = 0;
  const spans: [number, number][] = [];
  layers.forEach((l, i) => {
    const y0 = y;
    const y1 = i === layers.length - 1 ? H + 20 : y + (l.thickness_m / total) * H;
    y = y1;
    spans.push([y0, y1]);
    g.fillStyle = l.color;
    g.beginPath();
    g.moveTo(0, y0 + wave(0, y0, 3));
    for (let x = 0; x <= W; x += 16) g.lineTo(x, y0 + wave(x, y0, 3));
    for (let x = W; x >= 0; x -= 16) g.lineTo(x, y1 + wave(x, y1, 3));
    g.closePath();
    g.fill();
    // soft shading inside the band, darker at the bottom, plus a thin dark seam where the next layer starts
    const gr = g.createLinearGradient(0, y0, 0, y1);
    gr.addColorStop(0, "#ffffff2a");
    gr.addColorStop(0.5, "#00000000");
    gr.addColorStop(1, "#00000030");
    g.fillStyle = gr;
    g.fillRect(0, y0, W, y1 - y0);
  });
  spans.forEach(([y0, y1], i) => {
    const l = layers[i]!;
    // fibres: short faint strokes along the layer (reads as compacted soil in the reference)
    g.save();
    g.beginPath();
    g.rect(0, y0, W, y1 - y0);
    g.clip();
    for (let k = 0; k < (y1 - y0) * 1.1; k++) {
      const x = r() * W;
      const yy = y0 + r() * (y1 - y0);
      g.strokeStyle = `rgba(${r() < 0.5 ? "255,255,255" : "60,40,20"},${0.05 + r() * 0.08})`;
      g.lineWidth = 1 + r() * 1.6;
      g.beginPath();
      g.moveTo(x, yy);
      g.lineTo(x + 20 + r() * 70, yy + (r() - 0.5) * 3);
      g.stroke();
    }
    if (l.pebbles) {
      g.translate(0, y0);
      pebbles(g, W, y1 - y0, r, Math.round(((y1 - y0) / 40) * 55), 6, 17, ["#cdbba0", "#8a7863", "#e0d2bb", "#a0694a", "#6f6a62", "#b9a58d"], false);
    }
    g.restore();
  });
  grain(g, W, H, r, 0.2, 60000);
  const t = toTex(c);
  return { texture: t, tileM: total };
}

/** Pebble ground (the ramp slope): packed round stones. Tile = 9 m. */
export function pebbleTile(seed = 5) {
  const W = 1024;
  const c = mk(W, W);
  const g = c.getContext("2d")!;
  const r = rng(seed);
  g.fillStyle = "#8f7d6d";
  g.fillRect(0, 0, W, W);
  const pal = ["#b9a58d", "#8d7b6a", "#cbbca7", "#a98068", "#7a746d", "#d3c5ae", "#9c8571", "#b99a80", "#9a948a"];
  const placed: [number, number, number][] = [];
  for (let i = 0; i < 40000 && placed.length < 520; i++) {
    const rad = 16 + r() * 26;
    const x = r() * W;
    const y = r() * W;
    if (placed.some(([px, py, pr]) => { let dx = Math.abs(px - x); let dy = Math.abs(py - y); dx = Math.min(dx, W - dx); dy = Math.min(dy, W - dy); return Math.hypot(dx, dy) < (pr + rad) * 0.86; })) continue;
    placed.push([x, y, rad]);
  }
  placed.forEach(([x, y, rad]) => {
    const col = pal[Math.floor(r() * pal.length)]!;
    for (const dx of [-W, 0, W]) for (const dy of [-W, 0, W]) {
      const X = x + dx;
      const Y = y + dy;
      if (X < -rad || X > W + rad || Y < -rad || Y > W + rad) continue;
      const gr = g.createRadialGradient(X - rad * 0.3, Y - rad * 0.35, rad * 0.1, X, Y, rad);
      gr.addColorStop(0, "#ffffff77");
      gr.addColorStop(0.4, col);
      gr.addColorStop(1, "#00000055");
      g.fillStyle = gr;
      g.beginPath();
      g.ellipse(X, Y, rad, rad * (0.75 + r() * 0.2), r() * 3, 0, Math.PI * 2);
      g.fill();
    }
  });
  grain(g, W, W, r, 0.15, 12000);
  return { texture: toTex(c), tileM: 9 };
}

const SURFACES: Record<string, { base: string; speck: string[]; ripple: boolean }> = {
  sand: { base: "#e6d3a8", speck: ["#c9b79c", "#8d7b66", "#d8cab4"], ripple: true },
  grass: { base: "#7fae5a", speck: ["#5e8f42", "#9cc873", "#4f7d38"], ripple: false },
  rock: { base: "#a49a8c", speck: ["#7d7468", "#c2b8a8", "#5f574d"], ripple: false },
  snow: { base: "#f1f5f8", speck: ["#d6e0ea", "#ffffff"], ripple: false },
  asphalt: { base: "#4a4d52", speck: ["#6a6d72", "#33363a"], ripple: false },
};
/** Flat ground surface with dune ripples (sand) and specks. Tile = 8 m. */
export function surfaceTile(kind: string, tint?: string) {
  const s = SURFACES[kind] ?? SURFACES.sand!;
  const W = 512;
  const c = mk(W, W);
  const g = c.getContext("2d")!;
  const r = rng(3 + kind.length);
  g.fillStyle = tint ?? s.base;
  g.fillRect(0, 0, W, W);
  if (s.ripple) {
    for (let i = 0; i < 40; i++) {
      g.strokeStyle = `rgba(160,120,70,${0.04 + r() * 0.05})`;
      g.lineWidth = 2 + r() * 4;
      g.beginPath();
      const y = r() * W;
      g.moveTo(0, y);
      for (let x = 0; x <= W; x += 32) g.lineTo(x, y + Math.sin((x / W) * Math.PI * 4 + i) * 6);
      g.stroke();
    }
  }
  grain(g, W, W, r, 0.3, 30000);
  pebbles(g, W, W, r, 60, 1.5, 4, s.speck);
  return { texture: toTex(c), tileM: 8 };
}

const FACADE_PALS = [
  ["#e6eef5", "#a6bfd6", "#7295b3"],
  ["#f4f7f9", "#b4c9de", "#82a5c4"],
  ["#c9d8e4", "#7fa3c0", "#5c82a2"],
  ["#eef2f4", "#9bb8cf", "#6f93b0"],
  ["#d8e3ea", "#8fb0c8", "#6a8fab"],
  ["#efe8da", "#8fb7bf", "#5f8f9a"],
];
/** Glass tower facade: bands (or a window grid) between pale mullions. One tile = 14 m tall x 10 m wide. */
export function facadeTile(kind: number) {
  const W = 256;
  const c = mk(W, W);
  const g = c.getContext("2d")!;
  const r = rng(20 + kind);
  const [a, b, d] = FACADE_PALS[kind % FACADE_PALS.length]!;
  g.fillStyle = a!;
  g.fillRect(0, 0, W, W);
  const rows = 8 + (kind % 3) * 2;
  const grid = kind % 3 === 2;
  for (let i = 0; i < rows; i++) {
    const y = (i / rows) * W;
    const gr = g.createLinearGradient(0, y, 0, y + W / rows);
    gr.addColorStop(0, b!);
    gr.addColorStop(1, d!);
    g.fillStyle = gr;
    if (grid) { for (let x = 0; x < W; x += 32) g.fillRect(x + 3, y + 4, 26, (W / rows) * 0.6); } else g.fillRect(0, y + 3, W, (W / rows) * 0.62);
  }
  if (kind % 2) {
    g.fillStyle = "#ffffff66";
    for (let x = 0; x < W; x += 32) g.fillRect(x, 0, 3, W);
  }
  grain(g, W, W, r, 0.1, 3000);
  return toTex(c);
}

/** Vertical gradient strip (4 px wide) from a list of [offset, colour]. */
export function gradientStrip(stops: [number, string][], h = 512) {
  const c = mk(4, h);
  const g = c.getContext("2d")!;
  const gr = g.createLinearGradient(0, 0, 0, h);
  for (const [o, col] of stops) gr.addColorStop(o, col);
  g.fillStyle = gr;
  g.fillRect(0, 0, 4, h);
  return toTex(c, false);
}

/** Soft round blob (contact shadow / dust puff). */
export function blobTexture(alpha = 0.55) {
  const c = mk(128, 128);
  const g = c.getContext("2d")!;
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, `rgba(0,0,0,${alpha})`);
  gr.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

/** Text on a transparent plate for text_label. */
export function labelTexture(text: string, color: string) {
  const c = mk(1024, 256);
  const g = c.getContext("2d")!;
  g.font = "900 150px 'Arial Rounded MT Bold','Avenir Next Condensed','Helvetica Neue',Arial,sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.lineJoin = "round";
  g.lineWidth = 28;
  g.strokeStyle = "rgba(20,20,22,0.92)";
  g.strokeText(text, 512, 132, 980);
  g.fillStyle = color;
  g.fillText(text, 512, 132, 980);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
