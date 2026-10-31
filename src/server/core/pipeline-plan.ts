import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import type { GateId } from "@/server/core/gates";

// The route a video takes (Doc 2 4.1), and the pure decision "what happens next". No IO: the db layer builds the
// PipelineView from rows and acts on the Actions. Stages run strictly one after another; each stage's input hash
// covers the hash of the stage before it, so rerunning an early stage makes every later one stale automatically.

export type VideoFormat = "short" | "long";
export type VideoKind = "scene_kit" | "tsx" | "collage" | "ai";
export type ContentKindName = "script" | "beats" | "evidence" | "cost_plan" | "video" | "metadata" | "titles" | "narration" | "captions" | "scenes";

export const STAGE_NAMES = ["draft", "build", "generate", "tts", "render", "voice", "sfx", "qa"] as const;
export type StageName = (typeof STAGE_NAMES)[number];

export interface PlanStep {
  stage: StageName;
  gateBefore?: GateId;
  gateAfter?: GateId;
  resource: "cpu" | "render" | "net";
}

export interface PlanFlags {
  requireEvidence: boolean;
  /** true when the cost plan has paid items; only then does the generate stage (and the cost gate) exist */
  paidGeneration: boolean;
  /**
   * PLACEHOLDER until Phase 9 (imported projects): the script and scenes already exist, so the authoring stages (draft,
   * build) and the script gate are skipped. Nothing sets it yet.
   */
  imported?: boolean;
}

export function stagePlan(kind: VideoKind, format: VideoFormat, flags: PlanFlags): PlanStep[] {
  if (format === "long") throw new Error("long format is not built yet (Phase 6b)");
  void kind; // every kind shares the route in Phase 2
  const steps: PlanStep[] = flags.imported
    ? []
    : [
        { stage: "draft", gateAfter: "script", resource: "net" },
        { stage: "build", resource: "cpu" },
      ];
  if (flags.paidGeneration) steps.push({ stage: "generate", gateBefore: "cost", resource: "net" });
  steps.push(
    { stage: "tts", resource: "net" },
    { stage: "render", resource: "render" },
    { stage: "voice", resource: "cpu" },
    { stage: "sfx", resource: "cpu" },
    { stage: "qa", gateAfter: "video", resource: "cpu" },
  );
  return steps;
}

/** Owner gates after the last stage, in order: the stage's own gateAfter (video), evidence when required, publish. */
export function postStageGates(plan: readonly PlanStep[], flags: PlanFlags): GateId[] {
  const last = plan[plan.length - 1];
  const out: GateId[] = [];
  if (last?.gateAfter) out.push(last.gateAfter);
  if (flags.requireEvidence) out.push("evidence");
  out.push("publish");
  return out;
}

/** Content a stage reads, beyond the previous stage's hash. A new version of any of these makes the stage stale. */
// Render still reads beats + narration + scene.json; `scenes` is listed so a repaired or undone scene document makes a finished render stale.
export const STAGE_CONTENT_INPUTS: Readonly<Record<StageName, readonly ContentKindName[]>> = {
  draft: [],
  build: ["script"],
  generate: ["cost_plan"],
  tts: ["script"],
  render: ["beats", "narration", "scenes"],
  voice: [],
  sfx: [],
  qa: [],
};

export function stageInputHash(stage: StageName, upstream: Record<string, string>, settingsSnapshot: Record<string, unknown>): string {
  return sha256Hex(canonicalJson({ stage, upstream, settings: settingsSnapshot }));
}

export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "needs_decision" | "cancelled";
export const ACTIVE_STATUSES: readonly RunStatus[] = ["queued", "running", "needs_decision"];

export interface PipelineView {
  kind: VideoKind;
  format: VideoFormat;
  flags: PlanFlags;
  /** hash of the video's own parameters (topic, language, notes, kind, format) */
  paramsHash: string;
  /** latest owner send-back note for the script, or null */
  feedback: string | null;
  /** sha256 of the latest version of each content kind that exists */
  content: Partial<Record<ContentKindName, string>>;
  /** newest run per stage */
  runs: Partial<Record<StageName, { status: RunStatus; inputHash: string }>>;
  /** gates whose newest approval is valid for the live content right now */
  approved: ReadonlySet<GateId>;
}

export type Action =
  | { kind: "enqueue"; stage: StageName; inputHash: string }
  | { kind: "wait_stage"; stage: StageName; status: RunStatus }
  | { kind: "wait_gate"; gate: GateId }
  | { kind: "done" };

/** The hash a stage must have to be up to date, given the previous stage's run hash. */
export function expectedInputHash(view: PipelineView, stage: StageName, prevHash: string | null): string {
  const upstream: Record<string, string> = {};
  if (stage === "draft") {
    upstream.params = view.paramsHash;
    upstream.feedback = view.feedback ?? "";
  } else {
    upstream.prev = prevHash ?? "";
  }
  for (const k of STAGE_CONTENT_INPUTS[stage]) upstream[k] = view.content[k] ?? "none";
  return stageInputHash(stage, upstream, {});
}

/** Exactly one next action for a video (the route is sequential). Never reruns a stage that has an active run and never
 *  touches anything after the last stage except to say which owner gate is open. */
export function nextActions(view: PipelineView): Action[] {
  const plan = stagePlan(view.kind, view.format, view.flags);
  let prevHash: string | null = null;
  let prev: PlanStep | undefined;
  for (const step of plan) {
    const gates = [prev?.gateAfter, step.gateBefore].filter((g): g is GateId => g !== undefined);
    for (const g of gates) if (!view.approved.has(g)) return [{ kind: "wait_gate", gate: g }];
    const want = expectedInputHash(view, step.stage, prevHash);
    const run = view.runs[step.stage];
    if (run && ACTIVE_STATUSES.includes(run.status)) return [{ kind: "wait_stage", stage: step.stage, status: run.status }];
    if (!run || run.inputHash !== want) return [{ kind: "enqueue", stage: step.stage, inputHash: want }];
    if (run.status !== "succeeded") return [{ kind: "wait_stage", stage: step.stage, status: run.status }]; // failed or cancelled: a human reruns it
    prevHash = run.inputHash;
    prev = step;
  }
  for (const g of postStageGates(plan, view.flags)) if (!view.approved.has(g)) return [{ kind: "wait_gate", gate: g }];
  return [{ kind: "done" }];
}
