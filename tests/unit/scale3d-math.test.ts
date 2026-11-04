import { describe, expect, it } from "vitest";
import { SCALE3D_SAMPLE as S, beatFrames, beatIndexAt, cameraAt, cameraKeys, cameraPosition, formatHeight, layoutObjects, niceCeil, rulerRangeAt, rulerStep, rulerValue, totalFrames } from "../../src/shared/scale3d";

const placements = layoutObjects(S.objects);
const keys = cameraKeys(S, placements);
const total = S.beats.reduce((a, b) => a + b.duration_s, 0);

describe("beat timing", () => {
  it("adds up to exactly the video length, even with odd durations", () => {
    const d = [3.33, 4.17, 5.5, 2.01, 7.99];
    const f = beatFrames(d, 30);
    expect(f[0]!.from).toBe(0);
    f.slice(1).forEach((b, i) => expect(b.from).toBe(f[i]!.from + f[i]!.frames));
    expect(totalFrames(d, 30)).toBe(Math.round(23 * 30));
  });
  it("finds the beat for a frame", () => {
    const f = beatFrames([2, 3], 30);
    expect(beatIndexAt(f, 0)).toBe(0);
    expect(beatIndexAt(f, 59)).toBe(0);
    expect(beatIndexAt(f, 60)).toBe(1);
    expect(beatIndexAt(f, 9999)).toBe(1);
  });
});

describe("labels", () => {
  it.each([[1.74, "1.7 m"], [9.96, "10 m"], [79.4, "79 m"], [330, "330 m"], [999.6, "1 km"], [1200, "1.2 km"], [8849, "8.8 km"], [12345, "12 km"], [-3, "0 m"]])("%s -> %s", (m, text) => {
    expect(formatHeight(m)).toBe(text);
  });
  it("rounds a ruler top to a tidy number", () => {
    expect(niceCeil(87)).toBe(100);
    expect(niceCeil(260)).toBe(300);
    expect(niceCeil(200)).toBe(200);
    expect(niceCeil(1.2)).toBe(1.5);
  });
});

describe("layout", () => {
  it("puts the carried object under the crane's hook, off the ground, not in the row", () => {
    const crane = placements.find((p) => p.id === "crane")!;
    const mini = placements.find((p) => p.id === "mini")!;
    expect(mini.carriedBy).toBe("crane");
    expect(mini.y).toBeGreaterThan(0);
    expect(mini.y + mini.height).toBeLessThan(crane.height);
    expect(mini.x).toBeGreaterThan(crane.x);
  });
  it("keeps the big tower far to the side and behind a small focus", () => {
    const tower = placements.find((p) => p.id === "tower")!;
    const crane = placements.find((p) => p.id === "crane")!;
    expect(tower.z).toBeLessThan(crane.z);
    expect(Math.abs(tower.x - crane.x)).toBeGreaterThan(150);
  });
});

describe("camera path", () => {
  it("starts and ends on the same view when looping, and holds still at the ends", () => {
    const a = cameraAt(keys, 0);
    const b = cameraAt(keys, total);
    expect(b).toEqual(a);
    const eps = cameraAt(keys, 0.05);
    expect(Math.abs(eps.x - a.x)).toBeLessThan(0.5);
  });
  it("ends on the last view when not looping", () => {
    const k = cameraKeys({ ...S, loop_back: false }, placements);
    expect(cameraAt(k, total).x).toBeCloseTo(placements.find((p) => p.id === "house")!.x, 5);
  });
  it("glides through beat boundaries: no stop at the keyframes", () => {
    const speed = (t: number) => {
      const h = 0.02;
      const a = cameraAt(keys, t - h);
      const b = cameraAt(keys, t + h);
      return Math.hypot(b.x - a.x, b.y - a.y) / (2 * h);
    };
    // Speed at the middle of the climb beat (a key pair surrounds it) vs the beat boundaries: the boundary between
    // beat 2 and 3 (same crane, climbing on) must not drop to zero.
    const boundary = S.beats[0]!.duration_s + S.beats[1]!.duration_s;
    expect(speed(boundary)).toBeGreaterThan(0.5);
  });
  it("is continuous (no jumps) over the whole path", () => {
    let prev = cameraAt(keys, 0);
    for (let f = 1; f <= total * 30; f++) {
      const c = cameraAt(keys, f / 30);
      // Between two shots 300 m apart the camera moves fast, but never more than a few percent of the path per frame.
      expect(Math.abs(c.y - prev.y)).toBeLessThan(25);
      expect(Math.abs(c.x - prev.x)).toBeLessThan(60);
      prev = c;
    }
  });
  it("never overshoots the heights it was told to visit", () => {
    const ys = keys.map((k) => k.y);
    for (let f = 0; f <= total * 30; f++) {
      const y = cameraAt(keys, f / 30).y;
      expect(y).toBeGreaterThanOrEqual(Math.min(...ys) - 1e-6);
      expect(y).toBeLessThanOrEqual(Math.max(...ys) + 1e-6);
    }
  });
  it("frames a small focus close, so a big object elsewhere cannot dominate", () => {
    const craneKey = keys.find((k) => Math.abs(k.x - placements.find((p) => p.id === "crane")!.x) < 1e-6)!;
    const towerKey = keys.find((k) => Math.abs(k.x - placements.find((p) => p.id === "tower")!.x) < 1e-6)!;
    expect(craneKey.dist).toBeLessThan(towerKey.dist / 2);
  });
});

describe("ruler", () => {
  it("reads the camera's real height, not the time", () => {
    const crane = placements.find((p) => p.id === "crane")!;
    // Two moments at the same camera height (start and end of the loop) read the same.
    expect(rulerValue(cameraAt(keys, 0))).toBeCloseTo(rulerValue(cameraAt(keys, total)), 6);
    // The value is exactly the camera position's height at any time.
    for (const t of [3, 8.3, 12, 20.2, 28]) {
      const c = cameraAt(keys, t);
      expect(rulerValue(c)).toBe(cameraPosition(c).y);
    }
    // While climbing the crane the value follows the climb and stays within the crane's height.
    const mid = cameraAt(keys, 4 + 7 * 0.5);
    expect(rulerValue(mid)).toBeGreaterThan(5);
    expect(rulerValue(mid)).toBeLessThanOrEqual(crane.height + 1);
  });
  it("follows the focus: small for the street, large for the tower", () => {
    const street = rulerRangeAt(S, keys, 2);
    const tower = rulerRangeAt(S, keys, 26);
    expect(street).toBeLessThan(20);
    expect(tower).toBeGreaterThan(300);
    expect(rulerRangeAt(S, keys, 0)).toBeCloseTo(rulerRangeAt(S, keys, total), 6);
  });
  it("changes smoothly across beats (no jumps) and never leaves the camera outside it", () => {
    let prev = rulerRangeAt(S, keys, 0);
    for (let f = 1; f <= total * 30; f++) {
      const r = rulerRangeAt(S, keys, f / 30);
      expect(r / prev).toBeLessThan(1.15);
      expect(prev / r).toBeLessThan(1.15);
      expect(rulerValue(cameraAt(keys, f / 30))).toBeLessThanOrEqual(r * 1.05);
      prev = r;
    }
  });
  it("is monotone between the street view and the tower view", () => {
    // beat 4 (mini crane, ends at 21 s) to the tower climb: the range only grows from the last crane shot to the tower shot
    let prev = rulerRangeAt(S, keys, 18);
    for (let t = 18.1; t <= 28; t += 0.1) {
      const r = rulerRangeAt(S, keys, t);
      expect(r).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = r;
    }
  });
  it("uses a fixed range when asked, and tidy tick steps", () => {
    expect(rulerRangeAt({ ...S, ruler: { max_m: 400 } }, keys, 3)).toBe(400);
    expect(rulerStep(15)).toBe(2);
    expect(rulerStep(500)).toBe(100);
  });
});
