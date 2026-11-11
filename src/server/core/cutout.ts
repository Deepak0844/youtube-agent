// Cut-outs (Phase 8): the pure parts. A cut-out is a picture with a see-through background, made either by a model (the app's background remover) or
// by keying out a plain white background, then polished: eroded edge, feathered edge, trimmed to the object, padded, with an optional white sticker border.
// Pixels are plain RGBA bytes (4 per pixel, row by row) and masks are one byte per pixel. No IO.

export interface CutoutOptions {
  /** "model" asks the background remover; "white" keys out a plain white background that touches the picture's edge. */
  method: "model" | "white";
  /** Pixels eaten off the edge of the object (removes a halo of old background). 0 to 4. */
  erode: number;
  /** Pixels of soft edge. 0 to 8. */
  feather: number;
  /** Transparent margin left around the object, in pixels. 0 to 64. */
  pad: number;
  /** Width of a white sticker border around the object, in pixels; 0 = none. 0 to 24. */
  sticker: number;
  /** White method only: how far from pure white still counts as background. 0 to 80. */
  tolerance: number;
}

export const DEFAULT_CUTOUT: CutoutOptions = { method: "model", erode: 1, feather: 1, pad: 8, sticker: 0, tolerance: 24 };
const RANGES: Record<Exclude<keyof CutoutOptions, "method">, [number, number]> = { erode: [0, 4], feather: [0, 8], pad: [0, 64], sticker: [0, 24], tolerance: [0, 80] };

/** Reads form-like values (strings or numbers); anything missing takes the default, anything out of range or not a whole number is refused with a plain sentence. */
export function parseCutoutOptions(raw: Record<string, unknown>): { ok: true; value: CutoutOptions } | { ok: false; message: string } {
  const out: CutoutOptions = { ...DEFAULT_CUTOUT };
  const method = raw.method;
  if (method !== undefined && method !== "" && method !== "model" && method !== "white") return { ok: false, message: "Pick how to cut out: with the model, or by removing a white background." };
  if (method === "white" || method === "model") out.method = method;
  for (const [k, [lo, hi]] of Object.entries(RANGES) as Array<[keyof typeof RANGES, [number, number]]>) {
    const v = raw[k];
    if (v === undefined || v === "") continue;
    const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,3}$/.test(v) ? Number(v) : NaN;
    if (!Number.isInteger(n) || n < lo || n > hi) return { ok: false, message: `${k === "tolerance" ? "Tolerance" : k[0]!.toUpperCase() + k.slice(1)} has to be a whole number from ${lo} to ${hi}.` };
    out[k] = n;
  }
  return { ok: true, value: out };
}

/** Largest picture a cut-out is made from (pixels). The mask maths touches every pixel a few times. */
export const MAX_CUTOUT_PIXELS = 16_000_000;

// ---- masks ------------------------------------------------------------------------------------------------------------------------------

/** Background = near-white pixels connected to the picture's edge (white inside the object, such as eyes or a plate, is kept). Returns an alpha mask: 0 background, 255 object. */
export function whiteKeyMask(rgba: Uint8Array, w: number, h: number, tolerance: number): Uint8Array {
  const n = w * h;
  const near = (p: number) => {
    const i = p * 4;
    const floor = 255 - tolerance;
    return rgba[i]! >= floor && rgba[i + 1]! >= floor && rgba[i + 2]! >= floor;
  };
  const mask = new Uint8Array(n).fill(255);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  const push = (p: number) => {
    if (mask[p] === 255 && near(p)) {
      mask[p] = 0;
      queue[tail++] = p;
    }
  };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (head < tail) {
    const p = queue[head++]!;
    const x = p % w;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (p >= w) push(p - w);
    if (p < n - w) push(p + w);
  }
  return mask;
}

/** One pass along rows then columns of a window `2r+1` wide; `pick` combines a running window. */
function separable(mask: Uint8Array, w: number, h: number, r: number, kind: "min" | "max" | "mean"): Uint8Array {
  if (r <= 0) return mask.slice();
  const tmp = new Uint8Array(mask.length);
  const out = new Uint8Array(mask.length);
  const run = (src: Uint8Array, dst: Uint8Array, len: number, lines: number, stride: number, step: number) => {
    for (let l = 0; l < lines; l++) {
      const base = l * stride;
      for (let i = 0; i < len; i++) {
        const lo = Math.max(0, i - r);
        const hi = Math.min(len - 1, i + r);
        let acc = kind === "min" ? 255 : 0;
        for (let j = lo; j <= hi; j++) {
          const v = src[base + j * step]!;
          if (kind === "min") acc = Math.min(acc, v);
          else if (kind === "max") acc = Math.max(acc, v);
          else acc += v;
        }
        dst[base + i * step] = kind === "mean" ? Math.round(acc / (hi - lo + 1)) : acc;
      }
    }
  };
  run(mask, tmp, w, h, w, 1);
  run(tmp, out, h, w, 1, w);
  return out;
}

export const erodeMask = (m: Uint8Array, w: number, h: number, r: number): Uint8Array => separable(m, w, h, r, "min");
export const dilateMask = (m: Uint8Array, w: number, h: number, r: number): Uint8Array => separable(m, w, h, r, "max");
export const blurMask = (m: Uint8Array, w: number, h: number, r: number): Uint8Array => separable(m, w, h, r, "mean");

/** The box around every pixel whose mask value is above `threshold`, or null when there is none. */
export function maskBox(mask: Uint8Array, w: number, h: number, threshold = 8): { left: number; top: number; width: number; height: number } | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]! > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** The share of the picture that is see-through (alpha below 20). Used to refuse a "cut-out" that cut nothing out, or everything. */
export function transparentShare(alpha: Uint8Array): number {
  let t = 0;
  for (const a of alpha) if (a < 20) t++;
  return alpha.length === 0 ? 0 : t / alpha.length;
}

export const alphaOf = (rgba: Uint8Array): Uint8Array => {
  const a = new Uint8Array(rgba.length / 4);
  for (let i = 0; i < a.length; i++) a[i] = rgba[i * 4 + 3]!;
  return a;
};

/**
 * The polish: erode, feather, trim to the object, pad, and (optionally) a white sticker border. `rgba` already carries the cut-out alpha.
 * Returns a new picture (never touches the input), or null when nothing visible is left.
 */
export function polishRgba(rgba: Uint8Array, w: number, h: number, o: Pick<CutoutOptions, "erode" | "feather" | "pad" | "sticker">): { rgba: Uint8Array; width: number; height: number } | null {
  if (rgba.length !== w * h * 4) throw new RangeError("the pixel data does not match the size");
  let alpha = alphaOf(rgba);
  alpha = erodeMask(alpha, w, h, o.erode);
  alpha = blurMask(alpha, w, h, o.feather);
  const box = maskBox(alpha, w, h);
  if (!box) return null;
  const margin = o.pad + o.sticker;
  const ow = box.width + 2 * margin;
  const oh = box.height + 2 * margin;
  const out = new Uint8Array(ow * oh * 4); // transparent black
  const objAlpha = new Uint8Array(ow * oh);
  for (let y = 0; y < box.height; y++) {
    for (let x = 0; x < box.width; x++) {
      const s = (box.top + y) * w + (box.left + x);
      const d = (margin + y) * ow + (margin + x);
      objAlpha[d] = alpha[s]!;
      out[d * 4] = rgba[s * 4]!;
      out[d * 4 + 1] = rgba[s * 4 + 1]!;
      out[d * 4 + 2] = rgba[s * 4 + 2]!;
      out[d * 4 + 3] = alpha[s]!;
    }
  }
  if (o.sticker > 0) {
    const border = dilateMask(objAlpha, ow, oh, o.sticker);
    for (let p = 0; p < ow * oh; p++) {
      const a0 = out[p * 4 + 3]! / 255;
      const ab = border[p]! / 255;
      const a = a0 + ab * (1 - a0);
      if (a <= 0) continue;
      for (let c = 0; c < 3; c++) out[p * 4 + c] = Math.round((out[p * 4 + c]! * a0 + 255 * ab * (1 - a0)) / a);
      out[p * 4 + 3] = Math.round(a * 255);
    }
  }
  return { rgba: out, width: ow, height: oh };
}
