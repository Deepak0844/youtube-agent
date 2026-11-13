import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import { styleHashParts } from "../../../remotion/kit/presets";
import type { GateId } from "@/server/core/gates";

// The route a video takes (Doc 2 4.1), and the pure decision "what happens next". No IO: the db layer builds the
// PipelineView from rows and acts on the Actions. Stages run strictly one after another; each stage's input hash
// covers the hash of the stage before it, so rerunning an early stage makes every later one stale automatically.

export type VideoFormat = "short" | "long";
export type VideoKind = "scene_kit" | "tsx" | "collage" | "ai";
export type ContentKindName = "outline" | "script" | "beats" | "evidence" | "cost_plan" | "video" | "metadata" | "titles" | "narration" | "captions" | "scenes" | "tsx" | "thumbnail" | "clips";

// `repair_scenes` is on demand only (the owner asks for it): it is not in stagePlan, so nothing runs it automatically.
export const STAGE_NAMES = ["outline", "draft", "pictures", "build", "generate", "tts", "render", "tsx_author", "voice", "sfx", "qa", "repair_scenes", "reframe", "thumbnail", "derive", "shots", "seo", "reply_drafts"] as const; // seo = titles, description, tags: on demand, off the hash chain; reply_drafts = drafts for new comments, on demand
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
  /**
   * A short cut from a long video (Phase 6b.4): its script, beats, scenes, narration and captions come from the long video by the free `derive`
   * step (no model, no voice), the owner still approves the script, and the video goes on through Render, Voice, Sound and QA.
   */
  derived?: boolean;
}

export function stagePlan(kind: VideoKind, format: VideoFormat, flags: PlanFlags): PlanStep[] {
  // Derived short (Phase 6b.4): scene kit only, and never imported. Nothing is drafted, built or narrated: `derive` writes all of it from the long video.
  if (flags.derived) {
    if (kind !== "scene_kit" || format !== "short") throw new Error("only a scene-kit short can be derived from a long video");
    if (flags.imported) throw new Error("imported derived videos are not supported");
    return [
      { stage: "derive", gateAfter: "script", resource: "cpu" },
      { stage: "render", resource: "render" },
      { stage: "voice", resource: "cpu" },
      { stage: "sfx", resource: "cpu" },
      { stage: "qa", gateAfter: "video", resource: "cpu" },
    ];
  }
  // Long (Phase 6b.2): scene kit only. The short route with the outline step (and its gate) in front; the render stage picks the
  // landscape composition. Every other kind keeps refusing until its own slice ships.
  if (format === "long") {
    if (kind !== "scene_kit") throw new Error("long videos are only available for the scene kit for now");
    // An imported project has no outline to approve, and Draft and Render both need one: refuse instead of building a video that cannot render.
    if (flags.imported) throw new Error("imported long videos are not supported");
    return [{ stage: "outline", gateAfter: "outline", resource: "net" }, ...stagePlan(kind, "short", flags)];
  }
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
  // ai (Phase 8): voice first, so every clip is as long as its beat of narration. `shots` plans one clip per beat and prices it (the cost plan);
  // the owner approves the total at the cost gate; `generate` buys the clips (paid, capped, never twice); Build then lays them out as scenes. No pictures step.
  if (kind === "ai") {
    if (flags.imported) throw new Error("imported AI videos are not supported");
    return [
      { stage: "draft", gateAfter: "script", resource: "net" },
      { stage: "tts", resource: "net" },
      { stage: "shots", resource: "cpu" },
      { stage: "generate", gateBefore: "cost", resource: "net" },
      { stage: "build", resource: "cpu" },
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
  outline: [],
  draft: [],
  pictures: ["script", "beats"],
  build: ["script"],
  generate: ["cost_plan"],
  shots: ["script", "captions"],
  tts: ["script"],
  render: ["beats", "narration", "scenes"],
  tsx_author: ["script", "narration"],
  voice: [],
  sfx: [],
  qa: [],
  repair_scenes: ["scenes", "script"],
  reframe: [],
  thumbnail: [],
  derive: [],
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
  /** derived shorts only: a hash of the long video's scenes, beats, narration and captions the clip is made from. Absent = not derived (no hash changes). */
  derivedSource?: string;
  /** AI videos only: the routed clip model ("provider/model") and the locked character's asset id. Both count in the shot plan's hash. Absent = none (and no other hash changes). */
  clipRoute?: string | null;
  characterAsset?: string | null;
  /** long videos only: latest owner send-back note for the outline. Absent or null = never sent back, and then no hash changes. */
  outlineFeedback?: string | null;
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
  if (stage === "outline") {
    upstream.params = view.paramsHash;
    upstream.feedback = view.outlineFeedback ?? "";
  } else if (stage === "derive") {
    // The clip is made from the long video's finished content: a new version of any of it makes the clip (and everything after it) stale.
    upstream.params = view.paramsHash;
    upstream.source = view.derivedSource ?? "none";
  } else if (stage === "shots") {
    upstream.prev = prevHash ?? "";
    upstream.clip_route = view.clipRoute ?? "none";
    upstream.character = view.characterAsset ?? "none";
  } else if (stage === "draft") {
    upstream.params = view.paramsHash;
    upstream.feedback = view.feedback ?? "";
    // A long script is written against the approved outline: the outline step's hash and the outline content both count, so editing or
    // regenerating the outline makes the draft (and everything after it) stale. Short videos add nothing here.
    if (view.format === "long") {
      upstream.prev = prevHash ?? "";
      upstream.outline = view.content.outline ?? "none";
    }
  } else {
    upstream.prev = prevHash ?? "";
  }
  for (const k of STAGE_CONTENT_INPUTS[stage]) upstream[k] = view.content[k] ?? "none";
  if (view.kind === "ai" && stage === "build") upstream.clips = view.content.clips ?? "none"; // the generated clips Build lays out; only AI videos, so no other hash changes
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
