import { z } from "zod";
import { noteProblem } from "@/server/core/approvals";
import { DECISION_CHOICES, type DecisionChoice } from "@/server/core/decision";

// What the /queue forms are allowed to send back. Pure: no IO. Every value that decides an approval is what the page
// RENDERED and posts back (hash, content versions, the dollar figure); the server compares each with the live state and
// refuses the action when anything differs. Who is acting never comes from here: it is the session (requireOwner).

export const STALE_MESSAGE = "This changed while you were looking. Review again.";
export const BAD_FORM = "That request was not understood. Nothing was changed.";

export const QUEUE_GATES = ["script", "cost", "video", "evidence", "publish"] as const;
export type QueueGate = (typeof QUEUE_GATES)[number];
export const BREAKER_STAGES = ["draft", "build", "voice"] as const;
export type BreakerStage = (typeof BREAKER_STAGES)[number];

/** The decisions the page offers. raise_cap_and_rerun needs a budget scope the page cannot name yet (Phase 3). */
export const QUEUE_DECISION_CHOICES = DECISION_CHOICES.filter((c) => c !== "raise_cap_and_rerun");

export type FormLike = { get(name: string): unknown };
export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

/** kind:id:version for every content row the hash was computed from, sorted by kind. Rendered by the page, posted back, compared. */
export function versionsKey(v: Partial<Record<string, { id: string; version: number }>>): string {
  return Object.entries(v)
    .filter((e): e is [string, { id: string; version: number }] => e[1] !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, x]) => `${k}:${x.id}:${x.version}`)
    .join(",");
}

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const versions = z.string().min(1).max(600).regex(/^[a-z_]{1,20}:[0-9a-f-]{36}:[0-9]{1,9}(,[a-z_]{1,20}:[0-9a-f-]{36}:[0-9]{1,9}){0,6}$/i);
const text = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export interface GateInput {
  videoId: string;
  gate: QueueGate;
  seenHash: string;
  seenVersions: string;
  note: string | undefined;
  /** The owner ticked "I checked the captions". */
  captionsChecked?: boolean;
}

export function parseGateForm(f: FormLike, action: "approve" | "send_back"): Parsed<GateInput> {
  const gate = z.enum(QUEUE_GATES).safeParse(text(f.get("gate")));
  const videoId = uuid.safeParse(text(f.get("videoId")));
  if (!gate.success || !videoId.success) return { ok: false, message: BAD_FORM };
  const seenHash = hash.safeParse(text(f.get("seenHash")));
  const seenVersions = versions.safeParse(text(f.get("seenVersions")));
  if (!seenHash.success || !seenVersions.success) return { ok: false, message: STALE_MESSAGE };
  let note: string | undefined;
  if (action === "send_back") {
    const raw = text(f.get("note"));
    const problem = noteProblem(raw);
    if (problem) return { ok: false, message: "Write a short note (3 to 1000 characters) so the rewrite knows what to change." };
    note = raw!.trim();
  }
  return { ok: true, value: { videoId: videoId.data, gate: gate.data, seenHash: seenHash.data, seenVersions: seenVersions.data, note, captionsChecked: text(f.get("captionsChecked")) === "on" } };
}

export interface DecisionInput {
  stageRunId: string;
  choice: DecisionChoice;
  seenMaxMicroUsd: number;
  seenReason: string;
  /** The owner ticked "I checked the provider's billing page". */
  confirmed: boolean;
}

export function parseDecisionForm(f: FormLike): Parsed<DecisionInput> {
  const stageRunId = uuid.safeParse(text(f.get("stageRunId")));
  const choice = z.enum(QUEUE_DECISION_CHOICES as [DecisionChoice, ...DecisionChoice[]]).safeParse(text(f.get("choice")));
  const max = z.string().regex(/^[0-9]{1,15}$/).safeParse(text(f.get("seenMaxMicroUsd")));
  const reason = z.string().min(1).max(40).safeParse(text(f.get("seenReason")));
  if (!stageRunId.success || !choice.success) return { ok: false, message: BAD_FORM };
  if (!max.success || !reason.success) return { ok: false, message: STALE_MESSAGE };
  return { ok: true, value: { stageRunId: stageRunId.data, choice: choice.data, seenMaxMicroUsd: Number(max.data), seenReason: reason.data, confirmed: text(f.get("checked")) === "on" } };
}

export function parseIdForm(f: FormLike, field: string): Parsed<string> {
  const id = uuid.safeParse(text(f.get(field)));
  return id.success ? { ok: true, value: id.data } : { ok: false, message: BAD_FORM };
}

export function parseStageForm(f: FormLike): Parsed<BreakerStage> {
  const s = z.enum(BREAKER_STAGES).safeParse(text(f.get("stage")));
  return s.success ? { ok: true, value: s.data } : { ok: false, message: BAD_FORM };
}
