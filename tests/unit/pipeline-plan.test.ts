import { describe, expect, it } from "vitest";
import type { GateId } from "@/server/core/gates";
import {
  expectedInputHash,
  nextActions,
  stageInputHash,
  stagePlan,
  postStageGates,
  type PipelineView,
  type RunStatus,
  type StageName,
} from "@/server/core/pipeline-plan";

const flags = { requireEvidence: true, paidGeneration: true };
const base = (over: Partial<PipelineView> = {}): PipelineView => ({
  kind: "scene_kit",
  format: "short",
  flags,
  paramsHash: "p",
  feedback: null,
  content: {},
  runs: {},
  approved: new Set<GateId>(),
  ...over,
});

/** Walks the route like the db layer would: applies each enqueue as a succeeded run, approving every gate asked for. */
function walk(view: PipelineView, opts: { approve?: boolean } = { approve: true }) {
  const trail: string[] = [];
  const v = { ...view, runs: { ...view.runs }, content: { ...view.content }, approved: new Set(view.approved) };
  for (let i = 0; i < 40; i++) {
    const [a] = nextActions(v);
    if (!a) throw new Error("no action");
    if (a.kind === "enqueue") {
      trail.push(a.stage);
      v.runs[a.stage] = { status: "succeeded", inputHash: a.inputHash };
      if (a.stage === "draft") v.content.script = "s1";
      if (a.stage === "build") {
        v.content.beats = "b1";
        v.content.cost_plan = "c1";
      }
      if (a.stage === "tts") v.content.narration = "n1";
      continue;
    }
    if (a.kind === "wait_gate") {
      trail.push(`gate:${a.gate}`);
      if (!opts.approve) return { trail, v };
      v.approved.add(a.gate);
      continue;
    }
    trail.push(a.kind);
    return { trail, v };
  }
  throw new Error("did not settle");
}

describe("stagePlan", () => {
  it("has_the_documented_stages_and_gates_in_order", () => {
    const p = stagePlan("scene_kit", "short", flags);
    expect(p.map((s) => s.stage)).toEqual(["draft", "build", "generate", "tts", "render", "voice", "sfx", "qa"]);
    expect(p.find((s) => s.stage === "draft")?.gateAfter).toBe("script");
    expect(p.find((s) => s.stage === "generate")?.gateBefore).toBe("cost");
    expect(p.find((s) => s.stage === "qa")?.gateAfter).toBe("video");
    expect(postStageGates(p, flags)).toEqual(["video", "evidence", "publish"]);
  });
  it("generate_and_cost_gate_exist_only_with_paid_items", () => {
    const f = { requireEvidence: false, paidGeneration: false };
    const p = stagePlan("scene_kit", "short", f);
    expect(p.map((s) => s.stage)).not.toContain("generate");
    expect(p.some((s) => s.gateBefore === "cost")).toBe(false);
    expect(postStageGates(p, f)).toEqual(["video", "publish"]);
  });
  it("plan_for_long_format_throws_until_phase_6b", () => {
    expect(() => stagePlan("scene_kit", "long", flags)).toThrow(/not built yet/);
  });
});

describe("stageInputHash", () => {
  it("is_stable_and_sensitive_to_every_part", () => {
    const h = stageInputHash("draft", { a: "1" }, { s: 1 });
    expect(h).toBe(stageInputHash("draft", { a: "1" }, { s: 1 }));
    expect(h).not.toBe(stageInputHash("build", { a: "1" }, { s: 1 }));
    expect(h).not.toBe(stageInputHash("draft", { a: "2" }, { s: 1 }));
    expect(h).not.toBe(stageInputHash("draft", { a: "1" }, { s: 2 }));
  });
});

describe("nextActions", () => {
  it("happy_path_review_approve_and_void", () => {
    const first = walk(base(), { approve: false });
    expect(first.trail).toEqual(["draft", "gate:script"]);
    expect(walk(first.v, { approve: false }).trail).toEqual(["gate:script"]);
    const rest = walk(first.v);
    expect(rest.trail).toEqual(["gate:script", "build", "gate:cost", "generate", "tts", "render", "voice", "sfx", "qa", "gate:video", "gate:evidence", "gate:publish", "done"]);
    // an approval that stopped being valid (the db layer drops it from `approved`) re-opens the gate and nothing else moves
    const voided = { ...rest.v, approved: new Set<GateId>(["script", "cost", "video", "evidence"]) };
    expect(nextActions(voided)).toEqual([{ kind: "wait_gate", gate: "publish" }]);
  });
  it("stale_input_reruns_stage", () => {
    const { v } = walk(base());
    const stale = { ...v, content: { ...v.content, script: "s2" } }; // a new script version
    const [a] = nextActions(stale);
    expect(a).toMatchObject({ kind: "enqueue", stage: "build" });
    expect((a as { inputHash: string }).inputHash).not.toBe(v.runs.build?.inputHash);
  });
  it("cannot_rerun_while_job_active", () => {
    for (const status of ["queued", "running", "needs_decision"] as RunStatus[]) {
      const { v } = walk(base());
      const active = { ...v, content: { ...v.content, script: "s2" }, runs: { ...v.runs, build: { status, inputHash: v.runs.build!.inputHash } } };
      expect(nextActions(active)).toEqual([{ kind: "wait_stage", stage: "build", status }]);
    }
  });
  it("failed_or_cancelled_with_same_inputs_waits_for_a_human_not_an_automatic_rerun", () => {
    const { v } = walk(base());
    for (const status of ["failed", "cancelled"] as RunStatus[]) {
      const x = { ...v, runs: { ...v.runs, render: { status, inputHash: v.runs.render!.inputHash } } };
      expect(nextActions(x)).toEqual([{ kind: "wait_stage", stage: "render", status }]);
    }
  });
  it("send_back_reruns_the_draft_with_the_feedback_in_the_hash", () => {
    const { v } = walk(base());
    const sent = { ...v, feedback: "make the hook shorter" };
    const [a] = nextActions(sent);
    expect(a).toMatchObject({ kind: "enqueue", stage: "draft" });
    expect((a as { inputHash: string }).inputHash).toBe(expectedInputHash(sent, "draft", null));
    expect((a as { inputHash: string }).inputHash).not.toBe(v.runs.draft?.inputHash);
  });
  it("rerunning_an_early_stage_makes_later_ones_stale", () => {
    const { v } = walk(base());
    const newDraft = stageInputHash("draft", { x: "new" }, {});
    expect(expectedInputHash(v, "build", newDraft)).not.toBe(v.runs.build?.inputHash);
  });
  it("advance_never_touches_post_review_states", () => {
    const { v } = walk(base());
    expect(nextActions(v)).toEqual([{ kind: "done" }]);
    const onlyPublishOpen = { ...v, approved: new Set<GateId>(["script", "cost", "video", "evidence"]) };
    expect(nextActions(onlyPublishOpen)).toEqual([{ kind: "wait_gate", gate: "publish" }]);
  });
  it("register_validation_runs_for_unknown_stage_names_are_ignored", () => {
    const names = stagePlan("scene_kit", "short", flags).map((s) => s.stage);
    expect(new Set(names).size).toBe(names.length);
    const bad = base({ runs: { bogus: { status: "succeeded", inputHash: "x" } } as unknown as PipelineView["runs"] });
    expect(nextActions(bad)).toEqual([{ kind: "enqueue", stage: "draft" as StageName, inputHash: expectedInputHash(bad, "draft", null) }]);
  });
});
