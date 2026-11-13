import { describe, expect, it } from "vitest";
import type { GateId } from "@/server/core/gates";
import { expectedInputHash, nextActions, postStageGates, stagePlan, type PipelineView, type PlanFlags } from "@/server/core/pipeline-plan";

const flags: PlanFlags = { requireEvidence: true, paidGeneration: false };
const view = (over: Partial<PipelineView> = {}): PipelineView => ({
  kind: "ai", format: "short", flags, paramsHash: "p", feedback: null, content: {}, runs: {}, approved: new Set<GateId>(), ...over,
});
const names = (p: ReturnType<typeof stagePlan>) => p.map((s) => s.stage);

describe("the route of an AI video", () => {
  it("is voice first, then the shot plan, the cost gate, the paid clips, Build, Render and the rest; no pictures step", () => {
    const plan = stagePlan("ai", "short", flags);
    expect(plan).toEqual([
      { stage: "draft", gateAfter: "script", resource: "net" },
      { stage: "tts", resource: "net" },
      { stage: "shots", resource: "cpu" },
      { stage: "generate", gateBefore: "cost", resource: "net" },
      { stage: "build", resource: "cpu" },
      { stage: "render", resource: "render" },
      { stage: "voice", resource: "cpu" },
      { stage: "sfx", resource: "cpu" },
      { stage: "qa", gateAfter: "video", resource: "cpu" },
    ]);
    expect(names(plan)).not.toContain("pictures");
    expect(postStageGates(plan, flags)).toEqual(["video", "evidence", "publish"]);
  });
  it("is the same whatever the paid-generation flag says, and refuses long and imported", () => {
    expect(stagePlan("ai", "short", { ...flags, paidGeneration: true })).toEqual(stagePlan("ai", "short", flags));
    expect(() => stagePlan("ai", "long", flags)).toThrow(/scene kit/);
    expect(() => stagePlan("ai", "short", { ...flags, imported: true })).toThrow(/imported/);
  });
  it("no money moves before the owner approves the cost: generate waits at the cost gate, and the shot plan waits for narration", () => {
    const ok = (stage: Parameters<typeof expectedInputHash>[1], prev: string | null, v: PipelineView) => ({ status: "succeeded" as const, inputHash: expectedInputHash(v, stage, prev) });
    let v = view({ approved: new Set<GateId>(["script"]) });
    expect(nextActions(v)[0]).toMatchObject({ kind: "enqueue", stage: "draft" });
    const draft = ok("draft", null, v);
    const tts = ok("tts", draft.inputHash, v);
    const shots = ok("shots", tts.inputHash, v);
    v = view({ approved: new Set<GateId>(["script"]), runs: { draft, tts } });
    expect(nextActions(v)[0]).toMatchObject({ kind: "enqueue", stage: "shots" });
    v = view({ approved: new Set<GateId>(["script"]), runs: { draft, tts, shots } });
    expect(nextActions(v)).toEqual([{ kind: "wait_gate", gate: "cost" }]); // generate is behind the cost gate
    v = view({ approved: new Set<GateId>(["script", "cost"]), runs: { draft, tts, shots } });
    expect(nextActions(v)[0]).toMatchObject({ kind: "enqueue", stage: "generate" });
  });
});

describe("the shot plan's hash", () => {
  const h = (v: PipelineView) => expectedInputHash(v, "shots", "prev");
  it("changes with the routed clip model, the locked character, the script and the captions, and with a forced rerun", () => {
    const base = h(view());
    expect(h(view())).toBe(base);
    expect(h(view({ clipRoute: "seedance_video/m1" }))).not.toBe(base);
    expect(h(view({ clipRoute: "seedance_video/m1" }))).not.toBe(h(view({ clipRoute: "kling_video/kling-4.0" })));
    expect(h(view({ characterAsset: "asset-1" }))).not.toBe(base);
    expect(h(view({ content: { script: "s1" } }))).not.toBe(base);
    expect(h(view({ content: { captions: "c1" } }))).not.toBe(base);
    expect(h(view({ nonces: { shots: "n1" } }))).not.toBe(base);
    expect(expectedInputHash(view(), "shots", "other")).not.toBe(base);
  });
  it("a new cost plan makes the clips stale, and new clips make Build stale (AI only)", () => {
    expect(expectedInputHash(view({ content: { cost_plan: "a" } }), "generate", "p")).not.toBe(expectedInputHash(view({ content: { cost_plan: "b" } }), "generate", "p"));
    const b = (v: PipelineView) => expectedInputHash(v, "build", "p");
    expect(b(view({ content: { clips: "x" } }))).not.toBe(b(view({ content: { clips: "y" } })));
    // a scene-kit video's Build hash ignores clips entirely
    expect(b(view({ kind: "collage", content: { clips: "x" } }))).toBe(b(view({ kind: "collage", content: { clips: "y" } })));
  });
  it("leaves the hashes of other videos exactly as they were (the new fields are ignored unless set)", () => {
    const sk = (o: Partial<PipelineView> = {}) => view({ kind: "collage", ...o });
    for (const stage of ["draft", "build", "render", "tts"] as const) expect(expectedInputHash(sk({ clipRoute: "x/y", characterAsset: "z" }), stage, "p")).toBe(expectedInputHash(sk(), stage, "p"));
  });
});
