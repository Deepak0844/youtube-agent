import { describe, expect, it } from "vitest";
import { parsePalette } from "@/server/core/sfx-palette";
import { cueSheet, planFromCueSheet, SfxPlan } from "@/server/core/sfx-plan";

const cue = (id: string, atS: number, optional = false) => ({ id, itemId: "i" + id, atS, gainDb: -12, optional });

describe("sfx plan", () => {
  it("cue_sheet_matches_plan_order", () => {
    const plan = SfxPlan.parse({ version: 1, cues: [cue("b", 5), cue("a", 1, true)] });
    const lines = cueSheet(plan).trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("b");
    expect(lines[1]).toContain("5.00");
    expect(lines[2]).toContain("a");
    expect(lines[2]).toContain("optional");
  });
  it("refuses a bad plan", () => {
    expect(SfxPlan.safeParse({ version: 1, cues: [{ ...cue("a", -1) }] }).success).toBe(false);
    expect(SfxPlan.safeParse({ version: 1, cues: [{ ...cue("a", 1), gainDb: 7 }] }).success).toBe(false);
    expect(SfxPlan.safeParse({ version: 1, cues: Array.from({ length: 61 }, (_, i) => cue(String(i), 1)) }).success).toBe(false);
  });
});

describe("plan from a cue sheet", () => {
  const palette = parsePalette("sfx", { defaults: { model: "m", target_lufs: -20, ceiling_dbfs: -1.5 }, sounds: [{ id: "whoosh", category: "c", duration_s: 1, tags: ["whoosh"], prompt: "p" }] });
  const hit = async (tags: string[]) => (tags.includes("whoosh") ? "item-1" : undefined);
  it("maps a recipe id to the library item, with defaults", async () => {
    const plan = await planFromCueSheet({ cues: [{ id: "a", sound: "whoosh", atS: 2 }] }, palette, hit);
    expect(plan.cues).toEqual([{ id: "a", itemId: "item-1", atS: 2, gainDb: -12, optional: true }]);
  });
  it("drops an optional cue with no library clip, fails a required one", async () => {
    expect((await planFromCueSheet({ cues: [{ id: "a", sound: "boom", atS: 1 }] }, palette, hit)).cues).toEqual([]);
    await expect(planFromCueSheet({ cues: [{ id: "a", sound: "boom", atS: 1, optional: false }] }, palette, hit)).rejects.toThrow(/a/);
  });
});
