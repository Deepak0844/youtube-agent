import { AUDIT_EVENTS, isAuditEvent } from "@/server/core/audit-events";

// Pure words and ordering for the Home screen. No IO: src/server/db/home-data.ts reads the rows, this says what they mean.

export const STAGE_LABEL: Record<string, string> = {
  draft: "Writing the script",
  build: "Building the scenes",
  generate: "Making paid images and clips",
  tts: "Recording the voice",
  render: "Rendering the video",
  voice: "Mixing the voice",
  sfx: "Adding sound",
  qa: "Checking the video",
};
export const stageLabel = (name: string): string => STAGE_LABEL[name] ?? "A step";

export const GATE_LABEL: Record<string, string> = {
  script: "Script gate",
  cost: "Cost gate",
  video: "Video gate",
  evidence: "Evidence gate",
  publish: "Publish gate",
};
export const gateLabel = (gate: string): string => GATE_LABEL[gate] ?? "Gate";

/** "just now", "5 min", "3 h", "4 days" (the same steps as the queue page, so both screens read alike). */
export function agoLabel(at: Date | string, now = Date.now()): string {
  const t = typeof at === "string" ? Date.parse(at) : at.getTime();
  const min = Math.max(0, Math.round((now - t) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h`;
  return `${Math.round(min / 1440)} days`;
}

export type AttentionKind = "failed_stage" | "budget_held" | "paid_unclear" | "needs_decision" | "upload_failed";
export interface AttentionRow {
  kind: AttentionKind;
  videoId: string;
  topic: string;
  stage: string | null;
  at: Date;
}
const ATTENTION_ORDER: Record<AttentionKind, number> = { paid_unclear: 0, upload_failed: 1, budget_held: 2, needs_decision: 3, failed_stage: 4 };

/** Money questions first, then the rest; inside a kind, the longest waiting first. */
export function sortAttention<T extends Pick<AttentionRow, "kind" | "at">>(rows: T[]): T[] {
  return [...rows].sort((a, b) => ATTENTION_ORDER[a.kind] - ATTENTION_ORDER[b.kind] || a.at.getTime() - b.at.getTime());
}

export function attentionText(r: Pick<AttentionRow, "kind" | "stage">): { text: string; action: string } {
  const step = r.stage ? stageLabel(r.stage).toLowerCase() : "a step";
  switch (r.kind) {
    case "paid_unclear":
      return { text: `A paid call may have run during "${step}" and nobody knows if it was charged.`, action: "Check the job or decide" };
    case "budget_held":
      return { text: `Held: "${step}" stopped at a spending cap.`, action: "Decide" };
    case "needs_decision":
      return { text: `"${step}" is parked and needs your decision.`, action: "Decide" };
    case "upload_failed":
      return { text: "The upload to YouTube failed. Nothing is retried by itself.", action: "Open" };
    case "failed_stage":
      return { text: `"${step}" failed.`, action: "Open" };
  }
}

export type AttentionReasonInput = { upload: boolean; failed: boolean; budgetRefused: boolean; openIntent: boolean };
export function attentionKind(i: AttentionReasonInput): AttentionKind {
  if (i.upload) return "upload_failed";
  if (i.failed) return "failed_stage";
  if (i.budgetRefused) return "budget_held";
  return i.openIntent ? "paid_unclear" : "needs_decision";
}

const EVENT_TEXT: Record<string, string> = {
  "stage.started": "started",
  "stage.succeeded": "finished",
  "stage.failed": "failed",
  "stage.needs_decision": "is waiting for your decision",
  "stage.cancelled": "was cancelled",
  "gate.waiting": "is waiting for you",
  "gate.approved": "was approved",
  "gate.sent_back": "was sent back",
  "video.created": "was started",
  "video.done": "is done",
  "video.failed": "failed",
};
/** Feed types that tell the owner nothing (log lines, notification receipts) are left out of Recent activity. */
export const ACTIVITY_EVENT_TYPES = Object.keys(EVENT_TEXT);

export interface ActivityRow {
  at: Date;
  source: "event" | "audit";
  type: string;
  topic: string | null;
  stage: string | null;
  gate: string | null;
}
export interface ActivityItem {
  at: Date;
  text: string;
  videoId: string | null;
}

export function activityText(r: ActivityRow): string {
  if (r.source === "audit") return isAuditEvent(r.type) ? AUDIT_EVENTS[r.type] : "Something changed in the studio";
  const what = EVENT_TEXT[r.type] ?? "changed";
  const who = r.topic ? `"${r.topic}"` : "A video";
  if (r.type.startsWith("stage.") && r.stage) return `${who}: ${stageLabel(r.stage).toLowerCase()} ${what}`;
  if (r.type === "gate.waiting" && r.gate) return `${who}: ${gateLabel(r.gate).toLowerCase()} ${what}`;
  return `${who} ${what}`;
}

/** Newest first, cut to `limit`. */
export function mergeActivity(rows: Array<ActivityRow & { videoId?: string | null }>, limit: number): ActivityItem[] {
  return [...rows]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, limit)
    .map((r) => ({ at: r.at, text: activityText(r), videoId: r.videoId ?? null }));
}

export interface SpendFigure {
  spentMicroUsd: number;
  /** null = no limit */
  capMicroUsd: number | null;
}
/** "$4.20 of $15.00" or "$4.20, no limit". */
export function spendSentence(f: SpendFigure, usd: (micro: number) => string): string {
  return f.capMicroUsd === null ? `${usd(f.spentMicroUsd)}, no limit` : `${usd(f.spentMicroUsd)} of ${usd(f.capMicroUsd)}`;
}
