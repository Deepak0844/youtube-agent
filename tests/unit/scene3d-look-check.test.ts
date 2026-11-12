import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { framesPhrase, heroReportSchema, lookProblems, stillMetrics, type HeroReport } from "@/server/core/scene3d-look-check";
import { decodeStill } from "@/server/render/still-pixels";
import { heroShot } from "../../remotion/kit/s3k/framing";

// Synthetic 540x960 pictures: a flat colour, a white void, a good "sky / ground / subject" scene, and the same with the subject touching the left edge.
const W = 540, H = 960;
type Rgb = [number, number, number];
function picture(paint: (x: number, y: number) => Rgb): Uint8Array {
  const d = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const c = paint(x, y); d.set(c, (y * W + x) * 3); }
  return d;
}
const png = (raw: Uint8Array) => sharp(Buffer.from(raw), { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
const noise = (x: number, y: number) => ((x * 7 + y * 13) % 9) - 4;
const flat = (c: Rgb) => picture((x, y) => [c[0] + (noise(x, y) > 3 ? 1 : 0), c[1], c[2]]);
const whiteVoid = picture((x, y) => (x > 200 && x < 340 && y > 400 && y < 560 ? [190, 60, 40] : [252, 252, 252]));
const sceneWith = (subject: (x: number, y: number) => boolean) =>
  picture((x, y) => {
    if (subject(x, y)) return [150 + noise(x, y) * 3, 60, 50 + (x % 40)];
    if (y < 480) return [110 + Math.floor(y / 8), 160 + Math.floor(y / 12), 215]; // sky gradient
    return [90 + noise(x, y) * 4, 120 + (x % 30) + noise(y, x) * 3, 80]; // textured ground
  });
const good = sceneWith((x, y) => x > 130 && x < 410 && y > 330 && y < 700);
const cropped = sceneWith((x, y) => x < 260 && y > 150 && y < 700);
const heroOk: HeroReport = { declared: true, width: 0.45, height: 0.3, clipped: false };
/** Six good pictures whose shots differ (close and wide), as a real story's should. */
const okRun: HeroReport[] = [0.3, 0.45, 0.6, 0.4, 0.55, 0.35].map((w) => ({ declared: true, width: w, height: w * 0.7, clipped: false }));

describe("stillMetrics + lookProblems on synthetic pictures", () => {
  it("passes a good picture (sky, textured ground, a subject in the middle)", () => {
    expect(lookProblems([stillMetrics({ data: good, width: W, height: H })], null)).toEqual([]);
  });
  it("flags a flat picture as almost one flat colour", () => {
    expect(lookProblems([stillMetrics({ data: flat([40, 90, 140]), width: W, height: H })], null)).toEqual(["Frame 1 is almost one flat colour: there is nothing to see."]);
  });
  it("flags a white void with floating objects: no ground or horizon, naming the frames", () => {
    const m = stillMetrics({ data: whiteVoid, width: W, height: H });
    expect(m.lightShare).toBeGreaterThan(0.9);
    const p = lookProblems([m, stillMetrics({ data: good, width: W, height: H }), m], null);
    expect(p).toEqual(["Frames 1 and 3 show mostly empty white background: no ground or horizon. Add a ground or sea that reaches the horizon."]);
  });
  it("flags a black void", () => {
    const p = lookProblems([stillMetrics({ data: picture((x, y) => (x > 200 && x < 300 && y > 400 && y < 480 ? [200, 200, 80] : [5, 5, 8])), width: W, height: H })], null);
    expect(p[0]).toMatch(/^Frame 1 shows mostly empty black background/);
  });
  it("flags a subject cut off at the left edge, and not a centred one", () => {
    const p = lookProblems([stillMetrics({ data: cropped, width: W, height: H })], null);
    expect(p).toEqual(["The main subject looks cut off at the left edge in frame 1."]);
    expect(stillMetrics({ data: good, width: W, height: H }).edgeLeft).toBe(0);
  });
  it("flags an empty middle band", () => {
    const p = lookProblems([stillMetrics({ data: picture((x, y) => (y < 288 ? [40, 40, 200] : y > 720 ? [200, 40, 40] : [120 + (x % 3), 150, 120])), width: W, height: H })], null);
    expect(p).toEqual(["The middle of frame 1 is empty: the main subject is not there."]);
  });
  it("decodes a real PNG the same way", async () => {
    const raw = await decodeStill(await png(good));
    expect(raw.width).toBe(W);
    expect(stillMetrics(raw)).toEqual(stillMetrics({ data: good, width: W, height: H }));
  });
  it("refuses a PNG of the wrong size or garbage", async () => {
    await expect(decodeStill(await sharp({ create: { width: 100, height: 100, channels: 3, background: "#fff" } }).png().toBuffer())).rejects.toThrow();
    await expect(decodeStill(new Uint8Array([1, 2, 3]))).rejects.toThrow();
  });
});

describe("hero checks", () => {
  const m = stillMetrics({ data: good, width: W, height: H });
  const six = Array(6).fill(m);
  it("passes a hero of a good size that is never cut off", () => {
    expect(lookProblems(six, okRun)).toEqual([]);
  });
  it("says so when no hero is declared (every picture)", () => {
    expect(lookProblems(six, Array(6).fill({ declared: false }))[0]).toMatch(/^The scene does not mark a hero\. Wrap the main subject in <Hero>/);
  });
  it("skips the hero checks when the renderer gave no hero data", () => {
    expect(lookProblems(six, null)).toEqual([]);
  });
  it("flags a hero under 20 percent of the width in at least half of the pictures, not in fewer", () => {
    const small: HeroReport = { declared: true, width: 0.12, height: 0.1, clipped: false };
    expect(lookProblems(six, [small, small, small, heroOk, heroOk, heroOk])).toEqual(["The hero is too small in frames 1, 2 and 3 (under 20 percent of the frame width). Make it bigger or move the camera closer."]);
    expect(lookProblems(six, [small, small, heroOk, heroOk, heroOk, heroOk])).toEqual([]);
  });
  it("counts a tall, thin hero by its height (a crane 8 percent wide and half the frame high is fine)", () => {
    const crane = (h: number): HeroReport => ({ declared: true, width: 0.08, height: h, clipped: false });
    expect(lookProblems(six, [0.4, 0.5, 0.6, 0.45, 0.55, 0.5].map(crane))).toEqual([]);
    expect(lookProblems(six, Array(6).fill({ declared: true, width: 0.08, height: 0.2, clipped: false }))[0]).toMatch(/^The hero is too small in frames 1, 2, 3, 4, 5 and 6/);
  });
  it("flags a hero cut off by the frame in two or more pictures, not in one", () => {
    const cut: HeroReport = { declared: true, width: 0.5, height: 0.4, clipped: true };
    expect(lookProblems(six, [heroOk, cut, heroOk, heroOk, cut, heroOk])).toEqual(["The hero is cut off by the edge of the picture in frames 2 and 5. Frame it so all of it fits."]);
    expect(lookProblems(six, [heroOk, cut, heroOk, heroOk, heroOk, heroOk])).toEqual([]);
  });
  it("names the pictures with no hero when only some report one", () => {
    expect(lookProblems(six, okRun.map((h, i) => (i === 2 ? { declared: false as const } : h)))).toEqual(["The hero is not in frame 3."]);
  });
  it("flags a thin strip (under 12 percent of the frame height) in at least half of the pictures, not in fewer", () => {
    // The real linked-list run: a long row of boxes about 40 percent wide and 7 percent high in every picture.
    const strip = (w: number): HeroReport => ({ declared: true, width: w, height: 0.07, clipped: false });
    expect(lookProblems(six, [0.3, 0.5, 0.7, 0.4, 0.6, 0.35].map(strip))).toEqual(["The hero is a thin strip in frames 1, 2, 3, 4, 5 and 6 (under 12 percent of the frame height). Move the camera close to the part each beat talks about, or arrange the parts to fill more of the tall frame."]);
    expect(lookProblems(six, [strip(0.4), strip(0.5), ...okRun.slice(2)])).toEqual([]);
  });
  it("flags the same shot in every picture (width and height within 6 percent), not shots that differ", () => {
    expect(lookProblems(six, Array(6).fill(heroOk))).toEqual(["The hero is the same size in every picture: the camera never moves in. Give the beats different shots: close on the part each beat talks about, wide for the overview."]);
    expect(lookProblems(six, okRun)).toEqual([]);
    expect(lookProblems(six.slice(0, 3), Array(3).fill(heroOk))).toEqual([]);
  });
  it("flags both on the real linked-list numbers", () => {
    const real = [[0.382, 0.075], [0.411, 0.069], [0.396, 0.072], [0.407, 0.072], [0.401, 0.081], [0.382, 0.082], [0.388, 0.08], [0.399, 0.072]].map(([w, h]) => ({ declared: true as const, width: w!, height: h!, clipped: false }));
    const out = lookProblems(Array(8).fill(m), real);
    expect(out.some((p) => p.startsWith("The hero is a thin strip"))).toBe(true);
    expect(out.some((p) => p.startsWith("The hero is the same size in every picture"))).toBe(true);
  });
  it("never lists more than 8 problems", () => {
    expect(lookProblems(six, Array(6).fill({ declared: false })).length).toBeLessThanOrEqual(8);
  });
});

describe("helpers", () => {
  it("writes frame lists in plain words", () => {
    expect(framesPhrase([2])).toBe("Frame 3");
    expect(framesPhrase([1, 4])).toBe("Frames 2 and 5");
    expect(framesPhrase([0, 1, 3])).toBe("Frames 1, 2 and 4");
  });
  it("only accepts a well-formed hero report", () => {
    expect(heroReportSchema.safeParse({ declared: true, width: 0.3, height: 0.2, clipped: false }).success).toBe(true);
    expect(heroReportSchema.safeParse({ declared: true, width: 9, height: 0.2, clipped: false }).success).toBe(false);
    expect(heroReportSchema.safeParse({ declared: true, width: "0.3" }).success).toBe(false);
  });
  it("heroShot: share of the frame, clipped at the edge or behind the camera", () => {
    const box = (x0: number, x1: number, y0 = -0.2, y1 = 0.2) => [{ x: x0, y: y0, behind: false }, { x: x1, y: y1, behind: false }];
    expect(heroShot(box(-0.3, 0.3))).toEqual({ width: 0.3, height: 0.2, clipped: false });
    expect(heroShot(box(-0.3, 1.2)).clipped).toBe(true);
    expect(heroShot([{ x: 0, y: 0, behind: true }]).clipped).toBe(true);
    expect(heroShot([])).toEqual({ width: 0, height: 0, clipped: true });
  });
});
