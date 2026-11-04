import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import { styleHashParts } from "../../../remotion/kit/presets";
import type { GateId } from "@/server/core/gates";

// The route a video takes (Doc 2 4.1), and the pure decision "what happens next". No IO: the db layer builds the
// PipelineView from rows and acts on the Actions. Stages run strictly one after another; each stage's input hash
// covers the hash of the stage before it, so rerunning an early stage makes every later one stale automatically.

export type VideoFormat = "short" | "long";
export type VideoKind = "scene_kit" | "tsx" | "collage" | "ai" | "scale3d";
export type ContentKindName = "script" | "beats" | "evidence" | "cost_plan" | "video" | "metadata" | "titles" | "narration" | "captions" | "scenes" | "tsx";

// `repair_scenes` is on demand only (the owner asks for it): it is not in stagePlan, so nothing runs it automatically.
export const STAGE_NAMES = ["draft", "pictures", "build", "generate", "tts", "render", "tsx_author", "voice", "sfx", "qa", "repair_scenes", "reframe", "seo", "reply_drafts"] as const; // seo = titles, description, tags: on demand, off the hash chain; reply_drafts = drafts for new comments, on demand
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
  // tsx: the model writes one Remotion file after narration exists (word times), then it is checked, previewed and rendered
  // in one stage that replaces build + render. It never uses pictures, so tsx has no pictures step (a fall-back to the scene kit gets it
  // from the scene_kit route). Every other kind keeps the route below exactly as it was.
  if (kind === "tsx") {
    const head: PlanStep[] = flags.imported ? [] : [{ stage: "draft", gateAfter: "script", resource: "net" }];
    return [
      ...head,
      { stage: "tts", resource: "net" },
      { stage: "tsx_author", resource: "render" },
      { stage: "voice", resource: "cpu" },
      { stage: "sfx", resource: "cpu" },
      { stage: "qa", gateAfter: "video", resource: "cpu" },
    ];
  }
  // scale3d: Build asks the model for the 3D scene description (text only, $0 on Claude Code) and Render retimes its beats to the
  // narration, exactly like the scene kit. No pictures (the 3D models are a fixed library) and nothing to buy, so no generate step.
  if (kind === "scale3d") {
    const head: PlanStep[] = flags.imported ? [] : [{ stage: "draft", gateAfter: "script", resource: "net" }, { stage: "build", resource: "cpu" }];
    return [
      ...head,
      { stage: "tts", resource: "net" },
      { stage: "render", resource: "render" },
      { stage: "voice", resource: "cpu" },
      { stage: "sfx", resource: "cpu" },
      { stage: "qa", gateAfter: "video", resource: "cpu" },
    ];
  }
  const steps: PlanStep[] = flags.imported
    ? []
    : [
        { stage: "draft", gateAfter: "script", resource: "net" },
        { stage: "pictures", resource: "net" },
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
// Render reads beats, narration and the scenes (scenes.json from Build): a new scenes version makes Render stale.
export const STAGE_CONTENT_INPUTS: Readonly<Record<StageName, readonly ContentKindName[]>> = {
  draft: [],
  pictures: ["script", "beats"],
  build: ["script"],
  generate: ["cost_plan"],
  tts: ["script"],
  render: ["beats", "narration", "scenes"],
  tsx_author: ["script", "narration"],
  voice: [],
  sfx: [],
  qa: [],
  repair_scenes: ["scenes", "script"],
  reframe: [],
  seo: ["script"],
  reply_drafts: [],
};

/**
 * Stages that are NOT part of the hash chain: the next stage's hash is built on the last on-chain stage, as if they were
 * not there. Pictures is one: Build's hash stays exactly what it was before the stage existed, so no finished video turns stale.
 */
export const OFF_CHAIN_STAGES: readonly StageName[] = ["pictures"];

/** The route for one video. A video whose Build already started never gets the (newer) pictures stage queued late. */
export function routeFor(view: PipelineView): PlanStep[] {
  const plan = stagePlan(view.kind, view.format, view.flags);
  return !view.runs.pictures && view.runs.build ? plan.filter((s) => s.stage !== "pictures") : plan;
}

/** The nearest earlier step whose hash chains into plan[idx], or undefined for the first. */
export function chainPrev(plan: readonly PlanStep[], idx: number): PlanStep | undefined {
  for (let i = idx - 1; i >= 0; i--) if (!OFF_CHAIN_STAGES.includes(plan[i]!.stage)) return plan[i];
  return undefined;
}

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
  /** chosen look and caption layer; absent when none was chosen (then no hash changes) */
  style?: { style: string | null; captionStyle: string | null };
  /** latest owner send-back note for the script, or null */
  feedback: string | null;
  /** sha256 of the latest version of each content kind that exists */
  content: Partial<Record<ContentKindName, string>>;
  /** newest run per stage */
  runs: Partial<Record<StageName, { status: RunStatus; inputHash: string }>>;
  /** gates whose newest approval is valid for the live content right now */
  approved: ReadonlySet<GateId>;
  /** owner "run again" nonces per stage; absent or empty means never forced, and then no hash changes */
  nonces?: Partial<Record<StageName, string>>;
}

/** Steps the owner may force to run again. tts is paid for some voices, so it is only allowed while the voice route is free (ttsRerunProblem). Never a model step. */
export const FORCE_RERUN_STAGES: readonly StageName[] = ["tts", "render", "voice", "sfx", "qa"];

/** Voice providers that run on the owner's own machine or free service. custom_http is not here: it can bill. */
export const FREE_VOICE_PROVIDERS: readonly string[] = ["voicestudio", "local_openai", "edge"]; // local_openai also needs a loopback address (ttsRerunProblem)

/** True only for an http(s) address whose host is 127.0.0.1, localhost or ::1. Anything unparsable is not loopback. */
export function isLoopbackUrl(value: string | null | undefined): boolean {
  try {
    const u = new URL(value ?? "");
    return (u.protocol === "http:" || u.protocol === "https:") && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Why narration may not be forced to run again with this voice route, or null when it may (free voice). */
export function ttsRerunProblem(routeProviderId: string | null | undefined, localUrl?: string | null): string | null {
  if (!routeProviderId) return "No narration voice is chosen. Pick one in Settings > Providers first.";
  // local_openai is free only when its server is on this computer: a remote address may bill, and the adapter records $0.
  if (routeProviderId === "local_openai" ? isLoopbackUrl(localUrl) : FREE_VOICE_PROVIDERS.includes(routeProviderId)) return null;
  return `This voice is paid (${routeProviderId}). Re-running narration would be charged. Switch to a free voice, or ask for a paid re-run later.`;
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
  const nonce = view.nonces?.[stage];
  if (view.style && (stage === "build" || stage === "render")) Object.assign(upstream, styleHashParts(view.style.style, view.style.captionStyle)); // only when chosen: older hashes stay identical
  if (view.style?.style && stage === "tsx_author") upstream.style = view.style.style; // only when chosen: a tsx video with no style keeps its old hash
  if (nonce) upstream.nonce = nonce; // only when set: every hash made before forced reruns existed stays identical
  return stageInputHash(stage, upstream, {});
}

/** Exactly one next action for a video (the route is sequential). Never reruns a stage that has an active run and never
 *  touches anything after the last stage except to say which owner gate is open. */
export function nextActions(view: PipelineView): Action[] {
  const plan = routeFor(view);
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
    if (!OFF_CHAIN_STAGES.includes(step.stage)) prevHash = run.inputHash;
    prev = step;
  }
  for (const g of postStageGates(plan, view.flags)) if (!view.approved.has(g)) return [{ kind: "wait_gate", gate: g }];
  return [{ kind: "done" }];
}
