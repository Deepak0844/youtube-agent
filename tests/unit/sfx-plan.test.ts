import { describe, expect, it } from "vitest";
import { cueSheet, SfxPlan } from "@/server/core/sfx-plan";

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
