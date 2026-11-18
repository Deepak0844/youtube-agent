import { describe, expect, it } from "vitest";
import { montageSlots } from "@/server/core/montage-slots";

const beat = (id: string, text: string, o: { visual?: string; search?: string[] } = {}) => ({ id, text, ...o });
const sum = (s: { seconds: number }[]) => Math.round(s.reduce((a, x) => a + x.seconds, 0) * 1000) / 1000;

describe("montageSlots", () => {
  const beats = [
    beat("b1", "The night train leaves the quiet station while rain taps the window glass slowly.", { search: ["night train", "station"] }),
    beat("b2", "Lights slide past in long gold streaks across the empty seats beside you now.", { visual: "city lights through train window" }),
    beat("b3", "Nobody speaks.", {}),
    beat("b4", "And somewhere ahead the morning is already waiting for everyone on board today.", { search: ["sunrise"] }),
  ];
  it("one slot per beat, adding up to the narration exactly", () => {
    const s = montageSlots(beats, [], 30);
    expect(sum(s)).toBe(30);
    expect(s.map((x) => x.id)).toEqual(["b1", "b2", "b4"]); // b3 (very short) folded into b2
    expect(s.every((x) => x.seconds >= 2)).toBe(true);
  });
  it("query comes from the search words, else the visual, else the spoken text", () => {
    const s = montageSlots([beat("a", "x ".repeat(30), { search: ["ocean waves"] }), beat("b", "y ".repeat(30), { visual: "empty road" }), beat("c", "gentle morning river fog ".repeat(6))], [], 30);
    expect(s[0]!.query).toEqual(["ocean", "wave"]);
    expect(s[1]!.query).toEqual(["empty", "road"]);
    expect(s[2]!.query).toEqual(expect.arrayContaining(["gentle", "morning", "river", "fog"]));
  });
  it("no beats or no narration gives no slots", () => {
    expect(montageSlots([], [], 30)).toEqual([]);
    expect(montageSlots(beats, [], 0)).toEqual([]);
  });
});
