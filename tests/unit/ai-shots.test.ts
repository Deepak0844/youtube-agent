import { describe, expect, it } from "vitest";
import { beatWindows, clipSeconds, MAX_SHOTS, PROMPT_TAIL, planShots, shotCostItems, splitClipProvider } from "@/server/core/ai-shots";
import { buildCostPlan } from "@/server/core/cost-plan";
import { KnownFailure } from "@/server/core/paid-call";
import { MAX_CLIP_PROMPT, type VideoModelCap } from "@/server/core/video-clip";

const free: VideoModelCap = { id: "m", imageToVideo: true, endFrame: false, audio: false, aspects: ["9:16"], minSeconds: 4, maxSeconds: 15 };
const fixed: VideoModelCap = { ...free, minSeconds: 4, maxSeconds: 8, allowedSeconds: [4, 6, 8] };

describe("clipSeconds", () => {
  it("rounds the narration window up and keeps it inside the model's range", () => {
    expect(clipSeconds(free, 5.2)).toBe(6);
    expect(clipSeconds(free, 1)).toBe(4);
    expect(clipSeconds(free, 99)).toBe(15);
    expect(clipSeconds(free, 4)).toBe(4);
  });
  it("a model with fixed lengths takes the next one up, or its longest", () => {
    expect(clipSeconds(fixed, 4.1)).toBe(6);
    expect(clipSeconds(fixed, 6)).toBe(6);
    expect(clipSeconds(fixed, 6.5)).toBe(8);
    expect(clipSeconds(fixed, 30)).toBe(8);
    expect(clipSeconds(fixed, 0.5)).toBe(4);
  });
  it("a window that is not a number falls back to the shortest clip", () => {
    for (const w of [NaN, Infinity, -Infinity]) expect(clipSeconds(free, w)).toBe(4);
  });
});

describe("planShots", () => {
  const beats = [{ id: "b1", visual: "A red fox runs through snow." }, { id: "b2", visual: "The fox stops at a river" }];
  it("makes one shot per beat with the visual, the no-text tail and the clip length", () => {
    const r = planShots(beats, { b1: 5.5, b2: 3 }, free);
    expect(r).toEqual({ ok: true, shots: [{ beatId: "b1", prompt: `A red fox runs through snow. ${PROMPT_TAIL}`, seconds: 6 }, { beatId: "b2", prompt: `The fox stops at a river. ${PROMPT_TAIL}`, seconds: 4 }] });
  });
  it("names every beat that cannot be planned, and plans none of them", () => {
    const r = planShots([{ id: "a", visual: "  " }, { id: "b" }, { id: "c", visual: "ok scene" }, { id: "d", visual: "x".repeat(MAX_CLIP_PROMPT) }], { a: 3, b: 3, d: 3 }, free);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problems).toHaveLength(4);
      expect(r.problems.join("\n")).toMatch(/Beat a has no visual/);
      expect(r.problems.join("\n")).toMatch(/Beat b has no visual/);
      expect(r.problems.join("\n")).toMatch(/Beat c has no narration time/);
      expect(r.problems.join("\n")).toMatch(/Beat d has a visual that is too long/);
    }
  });
  it("refuses no beats, too many beats, and prototype-named beat ids", () => {
    expect(planShots([], {}, free).ok).toBe(false);
    const many = Array.from({ length: MAX_SHOTS + 1 }, (_, i) => ({ id: `b${i}`, visual: "a scene" }));
    expect(planShots(many, Object.fromEntries(many.map((b) => [b.id, 4])), free).ok).toBe(false);
    expect(planShots([{ id: "constructor", visual: "a scene" }], {}, free).ok).toBe(false);
    expect(planShots([{ id: "toString", visual: "a scene" }], { b: 4 }, free).ok).toBe(false);
  });
  it("a zero or negative window is not a window", () => {
    for (const w of [0, -2, NaN]) expect(planShots([{ id: "b", visual: "a scene" }], { b: w }, free).ok).toBe(false);
  });
});

describe("shotCostItems", () => {
  const shots = [{ beatId: "b1", prompt: "p", seconds: 6 }, { beatId: "b2", prompt: "p", seconds: 4 }];
  const price = { unit: "per_second", microUsd: 100_000 };
  it("prices each clip from the owner's per-second price and feeds the cost plan", () => {
    const items = shotCostItems(shots, "seedance_video", "dreamina-seedance-2-0-fast-260128", price);
    expect(items).toEqual([
      { kind: "clip", provider: "seedance_video/dreamina-seedance-2-0-fast-260128", quoteMicroUsd: 600_000 },
      { kind: "clip", provider: "seedance_video/dreamina-seedance-2-0-fast-260128", quoteMicroUsd: 400_000 },
    ]);
    expect(buildCostPlan(items, "ai").totalMicroUsd).toBe(1_000_000);
  });
  it("an unpriced model refuses the whole plan", () => {
    expect(() => shotCostItems(shots, "p_video", "m1", null)).toThrow(KnownFailure);
    expect(() => shotCostItems(shots, "p_video", "m1", { unit: "per_image", microUsd: 5 })).toThrow(KnownFailure);
  });
  it("splitClipProvider reads provider and model back and refuses anything else", () => {
    expect(splitClipProvider("seedance_video/dreamina-seedance-2-0-260128")).toEqual({ providerId: "seedance_video", model: "dreamina-seedance-2-0-260128" });
    for (const bad of ["seedance_video", "x/y", "a_b/../etc", "seedance_video/", "/model", "Seed/model-1", "a_video/m 1"]) expect(splitClipProvider(bad), bad).toBeNull();
  });
});

describe("beatWindows", () => {
  const word = (i: number) => ({ startS: i, endS: i + 0.8 }); // one word per second
  const words = Array.from({ length: 10 }, (_, i) => word(i));
  it("gives each beat its share of the spoken time, in order, and the last beat runs to the end of speech", () => {
    const w = beatWindows(words, [{ id: "a", text: "one two three four" }, { id: "b", text: "five six" }, { id: "c", text: "seven eight nine ten" }])!;
    expect(w.a).toBeCloseTo(4);
    expect(w.b).toBeCloseTo(2);
    expect(w.c).toBeCloseTo(3.8); // from word 7 (7s) to the end of word 10 (9.8s)
  });
  it("refuses to guess when the words and the beats do not match, or there is nothing to match", () => {
    expect(beatWindows(words, [{ id: "a", text: "only three words" }])).toBeNull();
    expect(beatWindows([], [{ id: "a", text: "x" }])).toBeNull();
    expect(beatWindows(words, [{ id: "a", text: "   " }])).toBeNull();
  });
  it("a beat id that looks like an object key is kept as a plain key", () => {
    const w = beatWindows(words, [{ id: "constructor", text: "a b c d e f g h i j" }])!;
    expect(Object.hasOwn(w, "constructor")).toBe(true);
  });
});
