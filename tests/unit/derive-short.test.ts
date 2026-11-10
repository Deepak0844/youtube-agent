import { describe, expect, it } from "vitest";
import { chapterSceneRange, clipBeats, clipNarration, clipScenes, clipWords, cutAudioArgs, planClip, CLIP_MAX_MS, CLIP_MIN_MS } from "@/server/core/derive-short";
import { validateScenes } from "@/shared/scene";

const sc = (i: number, beat: string, startMs: number, durationMs: number) => ({ id: `s${i}`, kind: "terminal", beat, startMs, durationMs, lines: [{ text: "ls" }] });
// c1: 0-20 s (two scenes), c2: 20-50 s (two scenes), c3: 50-120 s (one long scene run of three)
const scenes = [sc(1, "c1_b1", 0, 10_000), sc(2, "c1_b2", 10_000, 10_000), sc(3, "c2_b1", 20_000, 15_000), sc(4, "c2_b2", 35_000, 15_000), sc(5, "c3_b1", 50_000, 20_000), sc(6, "c3_b2", 70_000, 20_000), sc(7, "c3_b3", 90_000, 20_000)];

describe("planClip", () => {
  it("gives the window of consecutive scenes on the long video's timeline", () => {
    expect(planClip(scenes, { from: 2, to: 3 })).toEqual({ ok: true, window: { from: 2, to: 3, startMs: 20_000, endMs: 50_000, durationMs: 30_000 } });
  });
  it("refuses a range that is not in the video or backwards, in plain words", () => {
    for (const bad of [{ from: -1, to: 2 }, { from: 0, to: 7 }, { from: 3, to: 2 }, { from: 1.5, to: 3 }, { from: 0, to: Number.NaN }]) {
      expect(planClip(scenes, bad), JSON.stringify(bad)).toMatchObject({ ok: false, reason: expect.stringMatching(/first and a last scene/) });
    }
  });
  it("refuses a clip under the minimum or over the maximum length and says how long it is", () => {
    expect(planClip(scenes, { from: 0, to: 0 })).toMatchObject({ ok: false, reason: expect.stringMatching(/at least 15 seconds; this is 10/) });
    expect(planClip(scenes, { from: 0, to: 6 })).toMatchObject({ ok: false, reason: expect.stringMatching(/at most 90 seconds; this is 110/) });
    expect(CLIP_MIN_MS).toBeLessThan(CLIP_MAX_MS);
  });
  it("accepts exactly the limits", () => {
    expect(planClip(scenes, { from: 2, to: 6 }).ok).toBe(true); // 20 s to 110 s = exactly the 90 s maximum
    expect(planClip(scenes, { from: 0, to: 1 }, { minMs: 20_000 }).ok).toBe(true);
  });
});

describe("chapterSceneRange", () => {
  it("is the run of scenes whose beats start with the chapter's prefix", () => {
    expect(chapterSceneRange(scenes, 2)).toEqual({ from: 2, to: 3 });
    expect(chapterSceneRange(scenes, 3)).toEqual({ from: 4, to: 6 });
  });
  it("is null for a chapter with no scenes, for c1 vs c10, and for scenes that are not one run", () => {
    expect(chapterSceneRange(scenes, 9)).toBeNull();
    expect(chapterSceneRange([sc(1, "c10_b1", 0, 1000)], 1)).toBeNull();
    expect(chapterSceneRange([sc(1, "c1_b1", 0, 1000), sc(2, "c2_b1", 1000, 1000), sc(3, "c1_b2", 2000, 1000)], 1)).toBeNull();
  });
});

describe("clipScenes", () => {
  const w = (planClip(scenes, { from: 2, to: 3 }) as { ok: true; window: Parameters<typeof clipScenes>[1] }).window;
  it("starts the clip at 0 and keeps everything else of a scene", () => {
    const out = clipScenes(scenes, w);
    expect(out.map((s) => [s.id, s.startMs, s.durationMs])).toEqual([["s3", 0, 15_000], ["s4", 15_000, 15_000]]);
    expect(out[0]).toMatchObject({ kind: "terminal", beat: "c2_b1", lines: [{ text: "ls" }] });
    expect(scenes[2]!.startMs).toBe(20_000); // the input is not changed
  });
  it("is a valid short scene document", () => {
    expect(validateScenes({ version: 1, scenes: clipScenes(scenes, w) }).ok).toBe(true);
  });
});

describe("clipWords", () => {
  const words = [{ word: "a", startS: 19, endS: 20.5 }, { word: "b", startS: 21, endS: 22, estimated: true }, { word: "c", startS: 49.5, endS: 51 }, { word: "d", startS: 52, endS: 53 }];
  it("keeps the words spoken inside the window, shifted to 0, and cuts a word at an edge", () => {
    expect(clipWords(words, { startMs: 20_000, endMs: 50_000 })).toEqual([
      { word: "a", startS: 0, endS: 0.5 },
      { word: "b", startS: 1, endS: 2, estimated: true },
      { word: "c", startS: 29.5, endS: 30 },
    ]);
  });
  it("gives nothing for a window with no speech", () => expect(clipWords(words, { startMs: 100_000, endMs: 110_000 })).toEqual([]));
});

describe("clipBeats and clipNarration", () => {
  const beats = [{ id: "c1_b1", text: "One." }, { id: "c2_b1", text: " Two. " }, { id: "c2_b2", text: "Three." }, { id: 5 as never, text: "x" }];
  it("keeps the beats the clip's scenes use, once, in script order", () => {
    expect(clipBeats(beats, [{ beat: "c2_b2" }, { beat: "c2_b1" }, { beat: "c2_b1" }])).toEqual([beats[1], beats[2]]);
  });
  it("joins their text into the clip's narration", () => {
    expect(clipNarration([beats[1]!, beats[2]!, { text: 3 }, {}])).toBe("Two. Three.");
    expect(clipNarration([])).toBe("");
  });
});

describe("cutAudioArgs", () => {
  it("cuts the window into a pcm wav, with only the file protocol and no stdin", () => {
    expect(cutAudioArgs("narration.wav", "/x/clip.wav", { startMs: 20_000, durationMs: 30_000 })).toEqual(["-nostdin", "-hide_banner", "-y", "-protocol_whitelist", "file", "-i", "narration.wav", "-ss", "20.000", "-t", "30.000", "-vn", "-c:a", "pcm_s16le", "/x/clip.wav"]);
  });
});
