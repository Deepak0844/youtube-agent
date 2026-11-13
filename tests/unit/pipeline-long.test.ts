import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import type { GateId } from "@/server/core/gates";
import { expectedInputHash, stagePlan, STAGE_CONTENT_INPUTS, type PipelineView, type PlanFlags } from "@/server/core/pipeline-plan";

const flags: PlanFlags = { requireEvidence: true, paidGeneration: true };
const view = (over: Partial<PipelineView> = {}): PipelineView => ({
  kind: "collage", format: "long", flags, paramsHash: "p", feedback: null, content: {}, runs: {}, approved: new Set<GateId>(), ...over,
});
const names = (p: ReturnType<typeof stagePlan>) => p.map((s) => s.stage);

describe("short plans are pinned (Phase 6b must not change them)", () => {
  it("collage short (the old scene-kit route)", () => {
    expect(stagePlan("collage", "short", flags)).toEqual([
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
    for (const k of ["collage", "tsx"] as const) {
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
