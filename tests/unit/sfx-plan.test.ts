import { describe, expect, it } from "vitest";
import { parsePalette } from "@/server/core/sfx-palette";
import { readFileSync } from "node:fs";
import { cueSheet, planFromCueSheet, sanitizeCueSheet, SfxPlan } from "@/server/core/sfx-plan";

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
  it("drops a cue with no library clip, optional or not, and never fails", async () => {
    expect((await planFromCueSheet({ cues: [{ id: "a", sound: "boom", atS: 1 }] }, palette, hit)).cues).toEqual([]);
    expect((await planFromCueSheet({ cues: [{ id: "a", sound: "boom", atS: 1, optional: false }] }, palette, hit)).cues).toEqual([]);
  });
});

describe("sanitizing an engine's cue sheet", () => {
  const c = (o: object) => ({ id: "a", sound: "whoosh-soft", atS: 2, ...o });
  it("keeps good cues in time order and fills defaults", () => {
    expect(sanitizeCueSheet({ cues: [c({ id: "b", atS: 5 }), c({ id: "a", atS: 1 })] }, 40).cues.map((x) => [x.id, x.gainDb, x.optional])).toEqual([["a", -12, true], ["b", -12, true]]);
  });
  it("makes every cue optional, even one written as required", () => {
    expect(sanitizeCueSheet({ cues: [c({ optional: false })] }, 40).cues[0]!.optional).toBe(true);
  });
  it("drops junk, bad times and a repeat within 0.15 s; clamps gain", () => {
    const r = sanitizeCueSheet({ cues: [c({}), c({ id: "dup", atS: 2.1 }), c({ id: "late", atS: 40 }), c({ id: "neg", atS: -1 }), c({ id: "nan", atS: "x" }), "x", null, c({ id: "hot", sound: "pop-reveal", gainDb: 50 }), c({ id: "cold", sound: "riser-soft", atS: 3, gainDb: -90 })] }, 40);
    expect(r.cues.map((x) => [x.id, x.gainDb])).toEqual([["a", -12], ["hot", 6], ["cold", -30]]);
  });
  it("caps at 60 and treats a bad document as no cues", () => {
    const many = Array.from({ length: 80 }, (_, i) => c({ id: "i" + i, atS: i * 0.4 }));
    expect(sanitizeCueSheet({ cues: many }, 100).cues).toHaveLength(60);
    for (const bad of [null, "x", 3, {}, { cues: "no" }]) expect(sanitizeCueSheet(bad, 40).cues).toEqual([]);
    expect(sanitizeCueSheet({ cues: [c({})] }, 0).cues).toEqual([]);
  });
  it("every sound the engine skill names is a palette recipe with a clip in the library catalog", () => {
    const skill = readFileSync("engine-kit/skills/suggest-sfx/SKILL.md", "utf8").split("Sounds you can name:")[1]!;
    const named = [...skill.matchAll(/`([a-z][a-z-]+)`/g)].map((m) => m[1]!);
    const recipes = new Set((JSON.parse(readFileSync("assets-builtin/audio/sfx/palette.json", "utf8")) as { sounds: { id: string }[] }).sounds.map((s) => s.id));
    const clipped = new Set((JSON.parse(readFileSync("assets-builtin/audio/sfx/catalog.json", "utf8")) as { clips: { recipe?: string }[] }).clips.map((x) => x.recipe));
    expect(named.length).toBeGreaterThan(10);
    for (const n of named) { expect(recipes.has(n), n).toBe(true); expect(clipped.has(n), n).toBe(true); }
  });
});
