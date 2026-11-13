import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import type { GateId } from "@/server/core/gates";
import { expectedInputHash, nextActions, postStageGates, routeFor, stagePlan, STAGE_CONTENT_INPUTS, type PipelineView, type PlanFlags } from "@/server/core/pipeline-plan";

const flags: PlanFlags = { requireEvidence: true, paidGeneration: true };
const view = (over: Partial<PipelineView> = {}): PipelineView => ({
  kind: "scene_kit", format: "long", flags, paramsHash: "p", feedback: null, content: {}, runs: {}, approved: new Set<GateId>(), ...over,
});
const names = (p: ReturnType<typeof stagePlan>) => p.map((s) => s.stage);

describe("short plans are pinned (Phase 6b must not change them)", () => {
  it("scene_kit short", () => {
    expect(stagePlan("scene_kit", "short", flags)).toEqual([
      { stage: "draft", gateAfter: "script", resource: "net" },
      { stage: "pictures", resource: "net" },
      { stage: "build", resource: "cpu" },
      { stage: "generate", gateBefore: "cost", resource: "net" },
      { stage: "tts", resource: "net" },
      { stage: "render", resource: "render" },
      { stage: "voice", resource: "cpu" },
      { stage: "sfx", resource: "cpu" },
      { stage: "qa", gateAfter: "video", resource: "cpu" },
    ]);
  });
  it("tsx shorts", () => {
    const f = { requireEvidence: false, paidGeneration: false };
    expect(names(stagePlan("tsx", "short", f))).toEqual(["draft", "tts", "tsx_author", "voice", "sfx", "qa"]);
  });
  it("a short never has an outline step or outline gate", () => {
    for (const k of ["scene_kit", "tsx"] as const) {
      const p = stagePlan(k, "short", flags);
      expect(names(p)).not.toContain("outline");
      expect(p.some((s) => s.gateAfter === "outline")).toBe(false);
    }
  });
  it("a short's draft hash is exactly the one it always had (params + feedback only)", () => {
    const v = view({ format: "short", paramsHash: "abc", feedback: "fix it", outlineFeedback: "ignored for shorts", content: { outline: "x".repeat(64) } });
    const want = sha256Hex(canonicalJson({ stage: "draft", upstream: { params: "abc", feedback: "fix it" }, settings: {} }));
    expect(expectedInputHash(v, "draft", null)).toBe(want);
    expect(expectedInputHash(v, "draft", "something")).toBe(want);
    expect(STAGE_CONTENT_INPUTS.draft).toEqual([]);
  });
});

describe("long plan for the scene kit", () => {
  it("is outline, gate, then the short route in order, with the same gates after", () => {
    const p = stagePlan("scene_kit", "long", flags);
    expect(names(p)).toEqual(["outline", "draft", "pictures", "build", "generate", "tts", "render", "voice", "sfx", "qa"]);
    expect(p[0]).toEqual({ stage: "outline", gateAfter: "outline", resource: "net" });
    expect(p.find((s) => s.stage === "draft")?.gateAfter).toBe("script");
    expect(p.find((s) => s.stage === "generate")?.gateBefore).toBe("cost");
    expect(p.find((s) => s.stage === "qa")?.gateAfter).toBe("video");
    expect(postStageGates(p, flags)).toEqual(["video", "evidence", "publish"]);
    expect(p.some((s) => s.gateAfter === "chapter" || s.gateAfter === "thumbnail")).toBe(false);
  });
  it("is refused for every other kind with a clear message", () => {
    for (const k of ["tsx", "collage", "ai"] as const) expect(() => stagePlan(k, "long", flags)).toThrow("long videos are only available for the scene kit for now");
  });
  it("routeFor a long video is the long plan", () => {
    expect(names(routeFor(view()))[0]).toBe("outline");
  });
});

describe("outline gate and the hash chain", () => {
  it("starts with the outline, then waits at the outline gate; draft never runs before it is approved", () => {
    const v = view();
    expect(nextActions(v)).toMatchObject([{ kind: "enqueue", stage: "outline" }]);
    const after = view({ runs: { outline: { status: "succeeded", inputHash: expectedInputHash(v, "outline", null) } }, content: { outline: "o1" } });
    expect(nextActions(after)).toEqual([{ kind: "wait_gate", gate: "outline" }]);
    expect(nextActions(view({ ...after, approved: new Set<GateId>(["outline"]) }))).toMatchObject([{ kind: "enqueue", stage: "draft" }]);
  });
  it("editing the outline (new content version) makes the draft stale even though the outline run is unchanged", () => {
    const v = view();
    const outlineRun = { status: "succeeded" as const, inputHash: expectedInputHash(v, "outline", null) };
    const approved = new Set<GateId>(["outline"]);
    const withDraft = view({ approved, content: { outline: "o1" }, runs: { outline: outlineRun } });
    const draftHash = expectedInputHash(withDraft, "draft", outlineRun.inputHash);
    const settled = view({ approved, content: { outline: "o1", script: "s1" }, runs: { outline: outlineRun, draft: { status: "succeeded", inputHash: draftHash } } });
    expect(nextActions(settled)[0]).toMatchObject({ kind: "wait_gate", gate: "script" });
    const edited = { ...settled, content: { ...settled.content, outline: "o2" } };
    expect(nextActions({ ...edited, approved: new Set<GateId>() })).toEqual([{ kind: "wait_gate", gate: "outline" }]); // the db derives approvals from the hash, so the edit voids it; approved again:
    expect(nextActions(edited)).toMatchObject([{ kind: "enqueue", stage: "draft" }]);
  });
  it("an outline send-back note and a changed length range re-run the outline step; the script note does not", () => {
    const base = expectedInputHash(view(), "outline", null);
    expect(expectedInputHash(view({ outlineFeedback: "shorter please" }), "outline", null)).not.toBe(base);
    expect(expectedInputHash(view({ paramsHash: "p2" }), "outline", null)).not.toBe(base);
    expect(expectedInputHash(view({ feedback: "script note" }), "outline", null)).toBe(base);
  });
  it("the long draft hash covers the outline step, the outline content, the params and the script note", () => {
    const d = (over: Partial<PipelineView>, prev = "o") => expectedInputHash(view(over), "draft", prev);
    const h = d({ content: { outline: "o1" } });
    expect(d({ content: { outline: "o2" } })).not.toBe(h);
    expect(d({ content: { outline: "o1" } }, "o-other")).not.toBe(h);
    expect(d({ content: { outline: "o1" }, feedback: "n" })).not.toBe(h);
    expect(d({ content: { outline: "o1" }, paramsHash: "q" })).not.toBe(h);
  });
});

describe("an imported long video", () => {
  it("is refused: it has no outline to approve, and Draft and Render need one", () => {
    expect(() => stagePlan("scene_kit", "long", { ...flags, imported: true })).toThrow(/imported long/);
  });
});
