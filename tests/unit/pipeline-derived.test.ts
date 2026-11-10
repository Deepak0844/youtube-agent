import { describe, expect, it } from "vitest";
import type { GateId } from "@/server/core/gates";
import { expectedInputHash, nextActions, postStageGates, stagePlan, type PipelineView, type PlanFlags } from "@/server/core/pipeline-plan";

const flags: PlanFlags = { requireEvidence: true, paidGeneration: false, derived: true };
const view = (over: Partial<PipelineView> = {}): PipelineView => ({
  kind: "scene_kit", format: "short", flags, paramsHash: "p", feedback: null, content: {}, runs: {}, approved: new Set<GateId>(), derivedSource: "src1", ...over,
});
const names = (p: ReturnType<typeof stagePlan>) => p.map((s) => s.stage);

describe("the route of a short derived from a long video", () => {
  it("has no Draft, Pictures, Build, Generate or Narration: derive, the script gate, then Render, Voice, Sound, QA", () => {
    const plan = stagePlan("scene_kit", "short", flags);
    expect(plan).toEqual([
      { stage: "derive", gateAfter: "script", resource: "cpu" },
      { stage: "render", resource: "render" },
      { stage: "voice", resource: "cpu" },
      { stage: "sfx", resource: "cpu" },
      { stage: "qa", gateAfter: "video", resource: "cpu" },
    ]);
    for (const paid of ["draft", "pictures", "build", "generate", "tts", "outline"]) expect(names(plan)).not.toContain(paid);
  });
  it("still ends with the owner's video, evidence and publish gates, and keeps its script gate", () => {
    expect(postStageGates(stagePlan("scene_kit", "short", flags), flags)).toEqual(["video", "evidence", "publish"]);
    expect(nextActions(view({ runs: { derive: { status: "succeeded", inputHash: expectedInputHash(view(), "derive", null) } } }))).toEqual([{ kind: "wait_gate", gate: "script" }]);
  });
  it("starts with the free derive step, never a paid one", () => {
    expect(nextActions(view())[0]).toMatchObject({ kind: "enqueue", stage: "derive" });
  });
  it("is refused for anything but a scene-kit short, and for an imported project", () => {
    expect(() => stagePlan("tsx", "short", flags)).toThrow(/scene-kit short/);
    expect(() => stagePlan("scene_kit", "long", flags)).toThrow(/scene-kit short/);
    expect(() => stagePlan("scene_kit", "short", { ...flags, imported: true })).toThrow(/imported/);
  });
  it("a normal short and a long video keep their routes (the flag changes nothing else)", () => {
    expect(names(stagePlan("scene_kit", "short", { requireEvidence: true, paidGeneration: false }))).toEqual(["draft", "pictures", "build", "tts", "render", "voice", "sfx", "qa"]);
    expect(names(stagePlan("scene_kit", "long", { requireEvidence: true, paidGeneration: false }))[0]).toBe("outline");
  });
});

describe("the derive step's hash", () => {
  const h = (v: PipelineView) => expectedInputHash(v, "derive", null);
  it("changes with the long video's content and with the video's own parameters (the chosen scenes)", () => {
    const base = h(view());
    expect(h(view())).toBe(base);
    expect(h(view({ derivedSource: "src2" }))).not.toBe(base);
    expect(h(view({ paramsHash: "p2" }))).not.toBe(base);
  });
  it("is not touched by feedback, nonces of other steps or the outline, which do not apply to it", () => {
    expect(h(view({ feedback: "rewrite" }))).toBe(h(view()));
  });
  it("a video that is not derived gets no source part, so every existing hash stays what it was", () => {
    const plain: PipelineView = { ...view(), flags: { requireEvidence: true, paidGeneration: false }, derivedSource: undefined };
    expect(expectedInputHash(plain, "draft", null)).toBe(expectedInputHash({ ...plain, derivedSource: "anything" }, "draft", null));
  });
});
