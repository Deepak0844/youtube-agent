import { describe, expect, it } from "vitest";
import { bandCheckFrames, captionBandEdgeShare, changedShare, checkPreflight, EMPTY_BAND_MAX, EMPTY_FRAME0, isBlack, longestEmptyBand, isFlat, preflightFrames, zoneEdgeShare, type RgbFrame } from "@/server/core/tsx-preflight";

const W = 100;
const H = 200;
const SIZE = { width: W, height: H };
/** A frame filled by fn(x, y) -> [r, g, b]. */
const frame = (n: number, fn: (x: number, y: number) => [number, number, number], w = W, h = H): RgbFrame => {
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgb.set(fn(x, y), (y * w + x) * 3);
  return { frame: n, width: w, height: h, rgb };
};
const solid = (n: number, c: [number, number, number]) => frame(n, () => c);
/** Dark background with a 20x20 white square at (sx, sy). */
const square = (n: number, sx: number, sy = 50) => frame(n, (x, y) => (x >= sx && x < sx + 20 && y >= sy && y < sy + 20 ? [255, 255, 255] : [20, 30, 60]));

describe("preflightFrames", () => {
  it("first, middle and last, deduplicated", () => {
    expect(preflightFrames(90)).toEqual([0, 44, 89]);
    expect(preflightFrames(2700)).toEqual([0, 1349, 2699]);
    expect(preflightFrames(3)).toEqual([0, 1, 2]);
    expect(preflightFrames(2)).toEqual([0, 1]);
    expect(preflightFrames(1)).toEqual([0]);
  });
  it("empty for unusable lengths", () => {
    for (const d of [0, -1, 1.5, NaN, Infinity]) expect(preflightFrames(d)).toEqual([]);
  });
});

describe("pixel checks", () => {
  it("black: all or almost all near-black pixels", () => {
    expect(isBlack(solid(0, [0, 0, 0]))).toBe(true);
    expect(isBlack(solid(0, [16, 10, 5]))).toBe(true);
    expect(isBlack(frame(0, (x, y) => (x === 0 && y < 50 ? [255, 255, 255] : [0, 0, 0])))).toBe(true); // 0.25% lit
    expect(isBlack(square(0, 10))).toBe(false);
    expect(isBlack(frame(0, (x) => (x < 2 ? [255, 255, 255] : [0, 0, 0])))).toBe(false); // 2% lit: dark scene with content
  });

  it("flat: one colour, any colour, with tiny noise", () => {
    expect(isFlat(solid(0, [255, 255, 255]))).toBe(true);
    expect(isFlat(solid(0, [30, 120, 200]))).toBe(true);
    expect(isFlat(frame(0, (x, y) => [100 + ((x + y) % 2), 100, 100]))).toBe(true);
    expect(isFlat(square(0, 10))).toBe(false);
    expect(isFlat(frame(0, (x) => [x * 2, 0, 0]))).toBe(false); // gradient
  });

  it("changedShare counts moved pixels, ignores compression-level noise", () => {
    expect(changedShare(square(0, 10), square(1, 10))).toBe(0);
    expect(changedShare(square(0, 10), square(1, 50))).toBeCloseTo(800 / (W * H));
    expect(changedShare(solid(0, [100, 100, 100]), solid(1, [120, 120, 120]))).toBe(0);
    expect(changedShare(solid(0, [0, 0, 0]), solid(1, [0, 0, 0]))).toBe(0);
    expect(changedShare(square(0, 10), frame(1, () => [0, 0, 0], 10, 10))).toBeNull();
  });
});

describe("first-frame content (objects zone)", () => {
  const BIG = { width: 1080, height: 1920 };
  const gradient = (n: number) => frame(n, (x, y) => [10 + (y >> 6), 14 + (x >> 6), 40 + (y >> 5)], 1080, 1920);
  // a soft glow: a wide radial brightening, no sharp edge anywhere
  const glow = (n: number) => frame(n, (x, y) => { const k = Math.max(0, 1 - Math.hypot(x - 540, y - 800) / 700); return [Math.round(12 + 60 * k * k), Math.round(16 + 50 * k * k), Math.round(40 + 90 * k * k)]; }, 1080, 1920);
  const shapes = (n: number) => frame(n, (x, y) => (Math.hypot(x - 540, y - 800) < 150 || (x > 200 && x < 320 && y > 900 && y < 1250) ? [255, 220, 80] : [12, 16, 40]), 1080, 1920);
  it("a flat gradient and a glow-only frame fail with the retry message", () => {
    expect(zoneEdgeShare(gradient(0))).toBeLessThan(0.001);
    expect(zoneEdgeShare(glow(0))).toBeLessThan(0.001);
    expect(checkPreflight([gradient(0)], BIG).problems).toEqual([EMPTY_FRAME0]);
    expect(checkPreflight([glow(0)], BIG).problems).toEqual([EMPTY_FRAME0]);
    expect(EMPTY_FRAME0.length).toBeLessThanOrEqual(120);
  });
  it("glow plus bright shapes passes", () => {
    expect(zoneEdgeShare(shapes(0))).toBeGreaterThan(0.004);
    expect(checkPreflight([shapes(0)], BIG).ok).toBe(true);
  });
  it("shapes only outside the zone (in the title area) still fail", () => {
    const top = frame(0, (x, y) => (x > 100 && x < 900 && y > 80 && y < 300 ? [255, 255, 255] : [12, 16, 40]), 1080, 1920);
    expect(checkPreflight([top], BIG).problems).toEqual([EMPTY_FRAME0]);
  });
  it("only frame 0 is held to it", () => {
    expect(checkPreflight([shapes(0), glow(44), gradient(89)], BIG).ok).toBe(true);
  });
});

describe("checkPreflight", () => {
  it("passes when frames have content and something moves", () => {
    expect(checkPreflight([square(0, 10), square(44, 40), square(89, 10)], SIZE)).toEqual({ ok: true, problems: [] });
  });

  it("a loop (last == first) is fine when the middle moves", () => {
    expect(checkPreflight([square(0, 10), square(44, 60), square(89, 10)], SIZE).ok).toBe(true);
  });

  it("refuses black, blank and frozen frames with frame numbers", () => {
    expect(checkPreflight([solid(0, [0, 0, 0]), square(44, 40), square(89, 10)], SIZE).problems).toEqual(["Frame 0 is black."]);
    expect(checkPreflight([square(0, 10), solid(44, [255, 255, 255]), square(89, 10)], SIZE).problems).toEqual(["Frame 44 is blank (one flat colour)."]);
    expect(checkPreflight([square(0, 10), square(44, 10), square(89, 10)], SIZE).problems[0]).toMatch(/0, 44, 89 look identical: nothing moves/);
  });

  it("a single frame is checked for content only", () => {
    expect(checkPreflight([square(0, 10)], SIZE).ok).toBe(true);
    expect(checkPreflight([solid(0, [0, 0, 0])], SIZE).ok).toBe(false);
  });

  it("wrong size and unreadable buffers are problems, never exceptions", () => {
    expect(checkPreflight([square(0, 10)], { width: 1080, height: 1920 }).problems[0]).toMatch(/100x200, expected 1080x1920/);
    const broken: unknown[] = [
      undefined, null, 1, "x", {}, { frame: 0, width: W, height: H, rgb: new Uint8Array(5) },
      { frame: 0, width: W, height: H, rgb: Array.from({ length: W * H * 3 }, () => 0) },
      { frame: 0, width: -1, height: H, rgb: new Uint8Array(0) }, { frame: 0, width: 1e6, height: 1e6, rgb: new Uint8Array(3) },
      { frame: 0.5, width: W, height: H, rgb: new Uint8Array(W * H * 3) },
    ];
    for (const b of broken) {
      const r = checkPreflight([b], SIZE);
      expect(r.ok).toBe(false);
      expect(r.problems).toContain("A preview frame could not be read.");
    }
    for (const b of [undefined, null, "x", [], {}]) expect(checkPreflight(b, SIZE)).toEqual({ ok: false, problems: ["No preview frames were rendered."] });
  });

  it("a full-size 1080x1920 check is fast", () => {
    const big = (n: number, sx: number) => frame(n, (x) => (((x + sx) % 200 < 100) ? [255, 255, 255] : [10, 40, 90]), 1080, 1920);
    const fr = [big(0, 0), big(1349, 500), big(2699, 900)];
    const t = performance.now();
    expect(checkPreflight(fr, { width: 1080, height: 1920 }).ok).toBe(true);
    expect(performance.now() - t).toBeLessThan(500);
  });
});

// Engine frame check: spread the objects over the whole height. The largest empty horizontal band of the content area
// (200 to 1650 of 1920) must stay under EMPTY_BAND_MAX. Measured on real frames: good scenes 0.15 to 0.36, empty lower half 0.45+.
describe("longestEmptyBand", () => {
  const bar = (n: number, rows: Array<[number, number]>) => frame(n, (x, y) => (rows.some(([a, b]) => y >= a && y < b && x >= 10 && x < 90) ? [255, 255, 255] : [20, 30, 60]), 200, 384);
  it("is_small_when_objects_cover_the_height_and_large_when_the_lower_half_is_empty", () => {
    expect(longestEmptyBand(bar(1, [[60, 80], [140, 160], [220, 240], [300, 320]]))).toBeLessThan(0.3);
    expect(longestEmptyBand(bar(2, [[60, 80], [100, 120]]))).toBeGreaterThan(0.5);
  });
  it("ignores_the_top_and_bottom_margins_and_never_throws_on_junk", () => {
    expect(longestEmptyBand(bar(3, [[40, 60], [330, 350]]))).toBeGreaterThan(0.5); // content only at the edges of the area: the middle is empty
    expect(longestEmptyBand({ frame: 0, width: 0, height: 0, rgb: new Uint8Array(0) })).toBe(0);
  });
  it("checkPreflight_flags_an_empty_band_only_when_asked", () => {
    const f1 = frame(0, (x, y) => (y >= 40 && y < 60 && x < 90 ? [255, 255, 255] : [20, 30, 60]), 200, 384);
    const f2 = frame(1, (x, y) => (y >= 40 && y < 60 && x < 70 ? [255, 255, 255] : [20, 30, 60]), 200, 384);
    const size = { width: 200, height: 384 };
    expect(checkPreflight([f1, f2], size).problems.join()).not.toMatch(/empty band/i);
    const r = checkPreflight([f1, f2], size, { maxEmptyBand: EMPTY_BAND_MAX });
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toMatch(/Frame 0: .*empty band/i);
    expect(r.problems.join()).toMatch(/under 40%/);
  });
});

describe("landscape frames (L1)", () => {
  const LW = 200;
  const LH = 112; // 16:9ish, wider than tall
  const lsize = { width: LW, height: LH };
  const lsquare = (n: number, sy: number) => frame(n, (x, y) => (x >= 90 && x < 110 && y >= sy && y < sy + 20 ? [255, 255, 255] : [20, 30, 60]), LW, LH);
  it("an_object_in_the_landscape_zone_counts_as_content_on_frame_0", () => {
    expect(checkPreflight([lsquare(0, 40), lsquare(10, 45)], lsize).problems).toEqual([]);
  });
  it("an_empty_landscape_frame_0_is_refused", () => {
    const r = checkPreflight([frame(0, (x) => [20 + Math.floor(x / 2), 30, 60], LW, LH), lsquare(10, 40)], lsize);
    expect(r.problems).toContain(EMPTY_FRAME0);
  });
  it("the_empty_band_is_measured_against_the_landscape_content_area", () => {
    // content only at the very top: below it, a long empty run in the 8%..80% area
    const top = lsquare(5, 10);
    expect(longestEmptyBand(top)).toBeGreaterThan(0.4);
    expect(longestEmptyBand(lsquare(5, 45))).toBeLessThan(0.7);
  });
  // The captions sit at about 80% to 93% of a landscape frame's height; a picture must stay above them (draw-objects 5d: nothing important below y 860 of 1080).
  const rows = (n: number, y0: number, y1: number) => frame(n, (x, y) => (x >= 20 && x < 180 && y >= y0 && y < y1 ? [255, 255, 255] : [20, 30, 60]), LW, LH);
  it("an_object_running_into_the_caption_band_is_refused_by_the_engine_check_only", () => {
    expect(captionBandEdgeShare(rows(0, 40, 60))).toBe(0);
    expect(captionBandEdgeShare(rows(0, 70, 100))).toBeGreaterThan(0.01); // 100 of 112 rows: inside the band
    const bad = [rows(0, 40, 60), rows(10, 40, 100)];
    expect(checkPreflight(bad, lsize).problems.join()).not.toMatch(/caption/i); // the final render's own check does not ask
    const r = checkPreflight(bad, lsize, { maxEmptyBand: EMPTY_BAND_MAX });
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toMatch(/Frame 10: .*caption/i);
    expect(checkPreflight([rows(0, 40, 60), rows(10, 30, 85)], lsize, { maxEmptyBand: EMPTY_BAND_MAX }).problems.join()).not.toMatch(/caption/i); // ends at 76%: clear
  });
  it("a_label_in_a_middle_frame_is_caught_by_the_spread_frames", () => {
    const base = [rows(0, 40, 60), rows(10, 40, 60), rows(20, 40, 60)];
    const mid = rows(7, 40, 100); // a label that shows only mid-scene
    expect(checkPreflight(base, lsize, { maxEmptyBand: EMPTY_BAND_MAX }).problems.join()).not.toMatch(/caption/i);
    const r = checkPreflight(base, lsize, { maxEmptyBand: EMPTY_BAND_MAX, bandFrames: [mid] });
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toMatch(/Frame 7: .*caption/i);
    expect(checkPreflight(base, lsize, { bandFrames: [mid] }).problems.join()).not.toMatch(/caption/i); // only the engine check asks
  });
  it("bandCheckFrames_spreads_up_to_eight_frames_from_first_to_last", () => {
    expect(bandCheckFrames(0)).toEqual([]);
    expect(bandCheckFrames(1)).toEqual([0]);
    expect(bandCheckFrames(3)).toEqual([0, 1, 2]);
    const f = bandCheckFrames(1001);
    expect(f).toHaveLength(8);
    expect([f[0], f.at(-1)]).toEqual([0, 1000]);
    expect([...f].sort((a, b) => a - b)).toEqual(f);
  });
  it("a_tall_frame_has_no_caption_band_check", () => {
    expect(captionBandEdgeShare(frame(1, (x, y) => (y > 150 ? [255, 255, 255] : [20, 30, 60]), 100, 200))).toBe(0);
  });
});
