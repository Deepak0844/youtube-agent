import { describe, expect, it } from "vitest";
import { bedAudibility, bedChoiceHash, cueAudibility, cueRows, parseVerdicts, withBedChoice } from "@/server/core/sound-view";
import type { SfxPlan } from "@/server/core/sfx-plan";

const bed = { item: "b1", gainDb: -22, loop: true };
const plan: SfxPlan = { version: 1, cues: [{ id: "c2", itemId: "s2", atS: 5, gainDb: -12, optional: true }, { id: "c1", itemId: "s1", atS: 1, gainDb: -10, optional: false, note: "whoosh" }] };

describe("bedChoiceHash", () => {
  it("is stable and changes with any field", () => {
    expect(bedChoiceHash(bed)).toBe(bedChoiceHash({ loop: true, gainDb: -22, item: "b1" }));
    expect(bedChoiceHash(bed)).not.toBe(bedChoiceHash({ ...bed, item: "b2" }));
    expect(bedChoiceHash(bed)).not.toBe(bedChoiceHash({ ...bed, gainDb: -20 }));
    expect(bedChoiceHash(bed)).not.toBe(bedChoiceHash(null));
    expect(bedChoiceHash(null)).toHaveLength(16);
  });
});

describe("bedAudibility", () => {
  it("passes 10 to 32 dB under the voice, warns outside", () => {
    expect(bedAudibility(-34, -20).audible).toBe(true);
    expect(bedAudibility(-25, -20).audible).toBe(false); // 5 dB under: fights the voice
    expect(bedAudibility(-60, -20).audible).toBe(false); // 40 dB under: buried
    expect(bedAudibility(-30, -20).headroomDb).toBe(0);
  });
});

describe("cueAudibility", () => {
  it("uses the mixer rule", () => {
    expect(cueAudibility("c", -20, -20).audible).toBe(true);
    expect(cueAudibility("c", -50, -20).audible).toBe(false);
    expect(cueAudibility("c", -40, -80).id).toBe("c");
  });
});

describe("cueRows / withBedChoice / parseVerdicts", () => {
  it("lists bed first then cues by time, with names", () => {
    const rows = cueRows(withBedChoice(plan, bed), new Map([["b1", "Calm"], ["s2", "Pop"]]));
    expect(rows.map((r) => [r.kind, r.atS, r.label])).toEqual([["bed", null, "Calm"], ["sound", 1, "whoosh"], ["sound", 5, "Pop"]]);
  });
  it("leaves the plan alone with no choice", () => {
    expect(withBedChoice(plan, null)).toBe(plan);
  });
  it("ignores a malformed list", () => {
    expect(parseVerdicts("x")).toEqual([]);
    expect(parseVerdicts([{ id: "a", audible: true, headroomDb: 2 }])).toHaveLength(1);
  });
});
