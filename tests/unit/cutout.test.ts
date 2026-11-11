import { describe, expect, it } from "vitest";
import { alphaOf, blurMask, DEFAULT_CUTOUT, dilateMask, erodeMask, maskBox, parseCutoutOptions, polishRgba, transparentShare, whiteKeyMask } from "@/server/core/cutout";

/** A w x h picture: `bg` colour everywhere, `fg` where the test says so. */
function pic(w: number, h: number, bg: [number, number, number, number], fg: (x: number, y: number) => [number, number, number, number] | null): Uint8Array {
  const a = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a.set(fg(x, y) ?? bg, (y * w + x) * 4);
  return a;
}
const RED: [number, number, number, number] = [200, 20, 20, 255];
const WHITE: [number, number, number, number] = [255, 255, 255, 255];
const square = (x0: number, y0: number, x1: number, y1: number) => (x: number, y: number) => (x >= x0 && x <= x1 && y >= y0 && y <= y1 ? RED : null);

describe("parseCutoutOptions", () => {
  it("defaults, strings from a form, and a numbers", () => {
    expect(parseCutoutOptions({})).toEqual({ ok: true, value: DEFAULT_CUTOUT });
    expect(parseCutoutOptions({ method: "white", erode: "2", feather: 3, pad: "0", sticker: "12", tolerance: "40" })).toEqual({ ok: true, value: { method: "white", erode: 2, feather: 3, pad: 0, sticker: 12, tolerance: 40 } });
    expect(parseCutoutOptions({ method: "", erode: "" })).toEqual({ ok: true, value: DEFAULT_CUTOUT });
  });
  it("refuses anything out of range, not whole, odd text or another method", () => {
    for (const bad of [{ erode: 5 }, { feather: -1 }, { pad: 65 }, { sticker: 25 }, { tolerance: 81 }, { erode: "1.5" }, { pad: "1e2" }, { sticker: "-3" }, { erode: "abc" }, { pad: NaN }, { method: "magic" }, { erode: {} }]) {
      expect(parseCutoutOptions(bad as never), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
  });
});

describe("whiteKeyMask", () => {
  it("removes white that touches the edge but keeps white inside the object", () => {
    // a red ring with a white hole in the middle, on a white background
    const w = 21, h = 21;
    const rgba = pic(w, h, WHITE, (x, y) => (x >= 4 && x <= 16 && y >= 4 && y <= 16 ? (x >= 8 && x <= 12 && y >= 8 && y <= 12 ? WHITE : RED) : null));
    const m = whiteKeyMask(rgba, w, h, 10);
    expect(m[0]).toBe(0); // corner: background
    expect(m[10 * w + 10]).toBe(255); // the hole is white but enclosed: part of the object
    expect(m[5 * w + 5]).toBe(255);
  });
  it("tolerance decides how off-white still counts", () => {
    const w = 8, h = 8;
    const grey: [number, number, number, number] = [240, 240, 240, 255];
    const rgba = pic(w, h, grey, square(3, 3, 4, 4));
    expect(whiteKeyMask(rgba, w, h, 10)[0]).toBe(255); // 240 is not within 10 of 255
    expect(whiteKeyMask(rgba, w, h, 20)[0]).toBe(0);
  });
  it("a picture that is all white is all background, and an object touching every edge is all object", () => {
    expect(whiteKeyMask(pic(5, 5, WHITE, () => null), 5, 5, 5).every((v) => v === 0)).toBe(true);
    expect(whiteKeyMask(pic(5, 5, RED, () => null), 5, 5, 5).every((v) => v === 255)).toBe(true);
  });
});

describe("mask filters", () => {
  const w = 9, h = 9;
  const m = new Uint8Array(w * h);
  for (let y = 3; y <= 5; y++) for (let x = 3; x <= 5; x++) m[y * w + x] = 255; // 3x3 object
  it("erode shrinks by r, dilate grows by r, r=0 changes nothing and never touches the input", () => {
    const e = erodeMask(m, w, h, 1);
    expect([...e].filter((v) => v === 255)).toHaveLength(1);
    expect(e[4 * w + 4]).toBe(255);
    expect([...dilateMask(m, w, h, 1)].filter((v) => v === 255)).toHaveLength(25);
    expect(erodeMask(m, w, h, 0)).toEqual(m);
    expect(erodeMask(m, w, h, 0)).not.toBe(m);
    expect([...m].filter((v) => v === 255)).toHaveLength(9);
  });
  it("erode by more than the object is wide leaves nothing", () => expect(erodeMask(m, w, h, 2).every((v) => v === 0)).toBe(true));
  it("blur softens the edge without moving the middle of a big object", () => {
    const big = new Uint8Array(15 * 15);
    for (let y = 3; y < 12; y++) for (let x = 3; x < 12; x++) big[y * 15 + x] = 255;
    const b = blurMask(big, 15, 15, 1);
    expect(b[7 * 15 + 7]).toBe(255);
    expect(b[3 * 15 + 7]).toBeGreaterThan(0);
    expect(b[3 * 15 + 7]).toBeLessThan(255);
    expect(b[0]).toBe(0);
  });
  it("maskBox finds the object, null for none, and transparentShare counts see-through pixels", () => {
    expect(maskBox(m, w, h)).toEqual({ left: 3, top: 3, width: 3, height: 3 });
    expect(maskBox(new Uint8Array(4), 2, 2)).toBeNull();
    expect(transparentShare(Uint8Array.from([0, 255, 10, 200]))).toBe(0.5);
    expect(transparentShare(new Uint8Array(0))).toBe(0);
  });
});

describe("polishRgba", () => {
  const w = 30, h = 30;
  const src = (): Uint8Array => {
    const a = pic(w, h, [0, 0, 0, 0], square(10, 12, 19, 21)); // a 10 x 10 red square, rest see-through
    return a;
  };
  it("trims to the object and pads it", () => {
    const r = polishRgba(src(), w, h, { erode: 0, feather: 0, pad: 5, sticker: 0 })!;
    expect([r.width, r.height]).toEqual([20, 20]);
    expect(r.rgba[(5 * 20 + 5) * 4 + 3]).toBe(255); // the object starts at the pad
    expect(r.rgba[3]).toBe(0); // the margin is see-through
  });
  it("erode takes the edge off; feather makes a soft edge", () => {
    const e = polishRgba(src(), w, h, { erode: 1, feather: 0, pad: 0, sticker: 0 })!;
    expect([e.width, e.height]).toEqual([8, 8]);
    const f = polishRgba(src(), w, h, { erode: 0, feather: 2, pad: 0, sticker: 0 })!;
    const corner = f.rgba[3]!;
    expect(corner).toBeGreaterThan(0);
    expect(corner).toBeLessThan(255);
  });
  it("a sticker border is white, outside the object, and counted in the margin so it is not cut off", () => {
    const r = polishRgba(src(), w, h, { erode: 0, feather: 0, pad: 2, sticker: 3 })!;
    expect([r.width, r.height]).toEqual([20, 20]); // 10 + 2 * (2 + 3)
    const at = (x: number, y: number) => [...r.rgba.slice((y * 20 + x) * 4, (y * 20 + x) * 4 + 4)];
    expect(at(10, 10)).toEqual([200, 20, 20, 255]); // object colour kept
    expect(at(3, 10)).toEqual([255, 255, 255, 255]); // inside the border: white
    expect(at(0, 0)[3]).toBe(0); // the pad beyond the border: see-through
  });
  it("nothing left gives null, the input is never changed, and a wrong size is refused", () => {
    const empty = new Uint8Array(w * h * 4);
    expect(polishRgba(empty, w, h, { erode: 0, feather: 0, pad: 0, sticker: 0 })).toBeNull();
    const s = src();
    const copy = s.slice();
    polishRgba(s, w, h, { erode: 1, feather: 1, pad: 2, sticker: 2 });
    expect(s).toEqual(copy);
    expect(() => polishRgba(new Uint8Array(10), w, h, { erode: 0, feather: 0, pad: 0, sticker: 0 })).toThrow(RangeError);
    expect(alphaOf(s)).toHaveLength(w * h);
  });
});
