import { describe, expect, it } from "vitest";
import { boundsLengthMs, chapterClips, sceneBounds } from "@/server/core/derive-view";

const sc = (beat: string, startMs: number, durationMs: number) => ({ beat, startMs, durationMs });
// c1: 0-20 s, c2: 20-50 s, c3: 50-120 s (three scenes), c5 has no scenes, c4 is scattered
const scenes = [sc("c1_b1", 0, 10_000), sc("c1_b2", 10_000, 10_000), sc("c2_b1", 20_000, 15_000), sc("c2_b2", 35_000, 15_000), sc("c3_b1", 50_000, 20_000), sc("c3_b2", 70_000, 20_000), sc("c3_b3", 90_000, 30_000), sc("c4_b1", 120_000, 20_000), sc("c9_b1", 140_000, 20_000), sc("c4_b2", 160_000, 20_000)];
const titles = ["Hook", "How it works", "Why it matters", "Scattered", "Missing"];

describe("chapterClips", () => {
  const clips = chapterClips(scenes, titles);
  it("gives each chapter whose scenes form one run, with 1-based scene numbers and its length", () => {
    expect(clips.map((c) => [c.n, c.title, c.firstScene, c.lastScene, c.lengthMs])).toEqual([[1, "Hook", 1, 2, 20_000], [2, "How it works", 3, 4, 30_000], [3, "Why it matters", 5, 7, 70_000]]);
  });
  it("leaves out a chapter with no scenes or with scenes that are not one run", () => {
    expect(clips.some((c) => c.title === "Scattered" || c.title === "Missing")).toBe(false);
  });
  it("says in plain words when a chapter is not a usable length, and nothing when it is", () => {
    const long = chapterClips([sc("c1_b1", 0, 80_000), sc("c1_b2", 80_000, 30_000)], ["Long"]);
    expect(long[0]!.problem).toMatch(/at most 90 seconds; this is 110/);
    expect(clips[0]!.problem).toBeNull();
    expect(chapterClips([sc("c1_b1", 0, 5_000)], ["Tiny"])[0]!.problem).toMatch(/at least 15 seconds; this is 5/);
  });
});

describe("boundsLengthMs", () => {
  const b = sceneBounds(scenes);
  it("is the length from the start of the first scene to the end of the last (1-based)", () => {
    expect(boundsLengthMs(b, 3, 4)).toBe(30_000);
    expect(boundsLengthMs(b, 1, 10)).toBe(180_000);
    expect(boundsLengthMs(b, 5, 5)).toBe(20_000);
  });
  it("is null for numbers that are not a run inside the video", () => {
    for (const [a, c] of [[0, 2], [3, 2], [1, 11], [1.5, 2], [1, Number.NaN]] as const) expect(boundsLengthMs(b, a, c), `${a}-${c}`).toBeNull();
  });
});
