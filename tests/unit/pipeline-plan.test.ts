import { describe, expect, it } from "vitest";
import type { GateId } from "@/server/core/gates";
import {
  expectedInputHash,
  FORCE_RERUN_STAGES,
  FREE_VOICE_PROVIDERS,
  ttsRerunProblem,
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
      if (a.stage === "draft") {
        v.content.script = "s1";
        v.content.beats = "b1";
      }
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

describe("pictures stage", () => {
  const done = (view: PipelineView) => walk(view).v;
  it("runs_after_the_script_gate_before_build", () => {
    const first = walk(base(), { approve: false });
    expect(first.trail).toEqual(["draft", "gate:script"]);
    const v = { ...first.v, approved: new Set<GateId>(["script"]) };
    expect(nextActions(v)).toMatchObject([{ kind: "enqueue", stage: "pictures" }]);
  });
  it("does_not_change_the_build_hash_chain", () => {
    const v = done(base());
    expect(v.runs.pictures).toBeDefined();
    expect(v.runs.build?.inputHash).toBe(expectedInputHash(v, "build", v.runs.draft!.inputHash));
  });
  it("old_video_without_a_pictures_run_gets_no_pictures_and_no_stale_build", () => {
    const v = done(base());
    const old = { ...v, runs: { ...v.runs } };
    delete old.runs.pictures;
    const [a] = nextActions(old);
    expect(a).not.toMatchObject({ kind: "enqueue" });
    expect(old.runs.build?.inputHash).toBe(expectedInputHash(old, "build", old.runs.draft!.inputHash));
  });
  it("new_script_makes_pictures_stale_first", () => {
    const v = done(base());
    const re = { ...v, content: { ...v.content, script: "s2" } };
    expect(nextActions(re)).toMatchObject([{ kind: "enqueue", stage: "pictures" }]);
  });
});

describe("stagePlan", () => {
  it("has_the_documented_stages_and_gates_in_order", () => {
    const p = stagePlan("scene_kit", "short", flags);
    expect(p.map((s) => s.stage)).toEqual(["draft", "pictures", "build", "generate", "tts", "render", "voice", "sfx", "qa"]);
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
    expect(rest.trail).toEqual(["gate:script", "pictures", "build", "gate:cost", "generate", "tts", "render", "voice", "sfx", "qa", "gate:video", "gate:evidence", "gate:publish", "done"]);
    // an approval that stopped being valid (the db layer drops it from `approved`) re-opens the gate and nothing else moves
    const voided = { ...rest.v, approved: new Set<GateId>(["script", "cost", "video", "evidence"]) };
    expect(nextActions(voided)).toEqual([{ kind: "wait_gate", gate: "publish" }]);
  });
  it("stale_input_reruns_stage", () => {
    const { v } = walk(base());
    const stale = { ...v, content: { ...v.content, script: "s2" } }; // a new script version: pictures first, then build
    expect(nextActions(stale)).toMatchObject([{ kind: "enqueue", stage: "pictures" }]);
    const { pictures: _p, ...noPictures } = stale.runs; // a video made before the stage existed
    void _p;
    const [a] = nextActions({ ...stale, runs: noPictures });
    expect(a).toMatchObject({ kind: "enqueue", stage: "build" });
    expect((a as { inputHash: string }).inputHash).not.toBe(v.runs.build?.inputHash);
  });
  it("edited_scenes_make_render_stale", () => {
    const { v } = walk(base());
    const [a] = nextActions({ ...v, content: { ...v.content, scenes: "sc2" } });
    expect(a).toMatchObject({ kind: "enqueue", stage: "render" });
  });
  it("cannot_rerun_while_job_active", () => {
    for (const status of ["queued", "running", "needs_decision"] as RunStatus[]) {
      const { v } = walk(base());
      const active = { ...v, content: { ...v.content, script: "s2" }, runs: { ...v.runs, pictures: { status: "succeeded" as RunStatus, inputHash: expectedInputHash({ ...v, content: { ...v.content, script: "s2" } }, "pictures", v.runs.draft!.inputHash) }, build: { status, inputHash: v.runs.build!.inputHash } } };
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

describe("stage nonce (owner forced rerun)", () => {
  const f = { requireEvidence: false, paidGeneration: false };
  const done = () => walk(base({ flags: f })).v;
  it("no_nonce_leaves_every_hash_byte_identical", () => {
    const v = base({ flags: f, content: { beats: "b", narration: "n", scenes: "s" } });
    const old = stageInputHash("render", { prev: "t", beats: "b", narration: "n", scenes: "s" }, {});
    expect(expectedInputHash(v, "render", "t")).toBe(old);
    expect(expectedInputHash({ ...v, nonces: {} }, "render", "t")).toBe(old);
    expect(expectedInputHash({ ...v, nonces: { render: "" } }, "render", "t")).toBe(old);
  });
  it("a_nonce_changes_only_that_stage_hash", () => {
    const v = base({ flags: f });
    const n = { ...v, nonces: { render: "x" } };
    expect(expectedInputHash(n, "render", "t")).not.toBe(expectedInputHash(v, "render", "t"));
    expect(expectedInputHash(n, "voice", "t")).toBe(expectedInputHash(v, "voice", "t"));
  });
  it("forcing_render_makes_render_then_the_later_steps_stale", () => {
    const v = done();
    expect(nextActions(v)[0]?.kind).toBe("done");
    const forced = { ...v, nonces: { render: "x" } as const };
    const [a] = nextActions(forced);
    expect(a).toMatchObject({ kind: "enqueue", stage: "render" });
    const after = { ...forced, runs: { ...forced.runs, render: { status: "succeeded" as RunStatus, inputHash: (a as { inputHash: string }).inputHash } } };
    expect(nextActions(after)[0]).toMatchObject({ kind: "enqueue", stage: "voice" });
  });
});

describe("forcing narration (tts) only for a free voice", () => {
  const f = { requireEvidence: false, paidGeneration: false };
  it("free_set_and_refusal_text", () => {
    expect([...FREE_VOICE_PROVIDERS].sort()).toEqual(["edge", "local_openai", "voicestudio"]);
    for (const p of ["voicestudio", "edge"]) expect(ttsRerunProblem(p)).toBeNull();
    expect(ttsRerunProblem("elevenlabs")).toBe("This voice is paid (elevenlabs). Re-running narration would be charged. Switch to a free voice, or ask for a paid re-run later.");
    for (const p of ["google_tts", "azure_tts", "custom_http"]) expect(ttsRerunProblem(p)).toMatch(/paid/);
    expect(ttsRerunProblem(null)).toMatch(/No narration voice/);
    expect(ttsRerunProblem(undefined)).toMatch(/No narration voice/);
  });
  it("local_openai_is_free_only_on_a_loopback_address", () => {
    for (const u of ["http://127.0.0.1:8880", "http://localhost:8880", "http://[::1]:8880", "https://localhost"]) expect(ttsRerunProblem("local_openai", u)).toBeNull();
    for (const u of ["https://api.example.com", "http://192.168.1.5:8880", "http://127.0.0.1.evil.com", "", "not a url", null, undefined]) expect(ttsRerunProblem("local_openai", u)).toMatch(/paid \(local_openai\)/);
    expect(ttsRerunProblem("local_openai")).toMatch(/paid/);
  });
  it("tts_is_forceable_but_paid_steps_still_are_not", () => {
    expect(FORCE_RERUN_STAGES).toContain("tts");
    for (const s of ["draft", "build", "generate", "repair_scenes", "pictures"] as const) expect(FORCE_RERUN_STAGES).not.toContain(s);
  });
  it("forcing_tts_reruns_tts_then_render_voice_sfx_qa_once_each", () => {
    let v = walk(base({ flags: f })).v;
    expect(nextActions(v)[0]?.kind).toBe("done");
    v = { ...v, nonces: { tts: "x" } };
    const order: string[] = [];
    for (let i = 0; i < 10; i++) {
      const [a] = nextActions(v);
      if (a?.kind !== "enqueue") break;
      order.push(a.stage);
      v = { ...v, runs: { ...v.runs, [a.stage]: { status: "succeeded" as RunStatus, inputHash: a.inputHash } } };
    }
    expect(order).toEqual(["tts", "render", "voice", "sfx", "qa"]);
    expect(nextActions(v)[0]?.kind).toBe("done");
  });
});
