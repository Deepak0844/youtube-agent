import { describe, expect, it } from "vitest";
import { highlightCaption, toonInputFor } from "@/server/core/toon-input";

const beats = [
  { id: "b0", text: "Pay twenty rupees for a chai." },
  { id: "b1", text: "It costs ₹20 and takes 3 seconds." },
];
const words = "Pay twenty rupees for a chai It costs ₹20 and takes 3 seconds".split(" ").map((w, i) => ({ word: w, startS: i * 0.5, endS: i * 0.5 + 0.4 }));

describe("toonInputFor", () => {
  it("beat times come from the narration's words, in order, with no scenes of its own", () => {
    const t = toonInputFor({ beats, words, durationS: 7, orientation: "portrait", cast: [] });
    expect(t.timeline.scenes).toEqual([]);
    expect(t.timeline.beats).toHaveLength(2);
    expect(t.timeline.beats[0]!.startS).toBe(0);
    expect(t.timeline.beats[0]!.endS).toBeLessThanOrEqual(t.timeline.beats[1]!.startS + 1e-9);
    expect(t.timeline.beats[1]!.endS).toBeCloseTo(7, 5);
  });
  it("a re-voice (new word times) moves the beats without touching the scene", () => {
    const slower = words.map((w) => ({ ...w, startS: w.startS * 2, endS: w.endS * 2 }));
    const a = toonInputFor({ beats, words, durationS: 7, orientation: "portrait", cast: [] });
    const b = toonInputFor({ beats, words: slower, durationS: 14, orientation: "portrait", cast: [] });
    expect(b.timeline.beats[1]!.startS).toBeGreaterThan(a.timeline.beats[1]!.startS);
  });
  it("a chapter is already on its own clock: B0 is its first beat", () => {
    const chapter = toonInputFor({ beats: beats.slice(1), words: words.slice(6).map((w) => ({ ...w, startS: w.startS - 3, endS: w.endS - 3 })), durationS: 12, orientation: "landscape", cast: [] });
    expect(chapter.timeline.beats[0]!.startS).toBe(0);
    expect(chapter.orientation).toBe("landscape");
  });
  it("carries the cast and the style", () => {
    const cast = [{ name: "Raju", role: "the customer", style: "cartoon_comic" as const, options: { skin: "#b07a52" } }];
    expect(toonInputFor({ beats, words, durationS: 7, orientation: "portrait", cast, style: "cartoon_comic" })).toMatchObject({ cast, style: "cartoon_comic" });
  });
});

describe("highlightCaption", () => {
  it("marks numbers, money and shouted words, at most three, and strips stray stars", () => {
    expect(highlightCaption("It costs ₹20 and takes 3 seconds")).toBe("It costs *₹20* and takes *3* seconds");
    expect(highlightCaption("NOPE, only a message does")).toBe("*NOPE,* only a message does");
    expect(highlightCaption("1 2 3 4 5").match(/\*/g)).toHaveLength(6);
    expect(highlightCaption("a *b* c")).toBe("a b c");
  });
});
