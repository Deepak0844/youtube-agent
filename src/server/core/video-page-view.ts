import type { GateId } from "@/server/core/gates";
import type { RunStatus, StageName } from "@/server/core/pipeline-plan";
import { microToUsd } from "@/server/core/llm-catalog";

// Pure view-model for the video page (/videos/[id]). No IO: tab parsing, the stage strip's plain words, the time estimate
// rule, and the QA findings shape. Nothing here invents a number: no estimate unless there are enough past runs.

export const TABS = [
  { id: "script", label: "Script" },
  { id: "beats", label: "Beats" },
  { id: "evidence", label: "Evidence" },
  { id: "titles", label: "Titles" },
  { id: "cost", label: "Cost" },
  { id: "qa", label: "QA" },
  { id: "audit", label: "Audit" },
  { id: "log", label: "Log" },
] as const;
export type TabId = (typeof TABS)[number]["id"];

/** Anything unknown falls back to Script (never an error). */
export function parseTab(raw: unknown): TabId {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return TABS.find((t) => t.id === v)?.id ?? "script";
}

export const STAGE_LABELS: Record<StageName, string> = {
  draft: "Draft", build: "Build", generate: "Generate", tts: "Narration", render: "Render", voice: "Voice", sfx: "Sound", qa: "Check", repair_scenes: "Scene repair",
};
const VERB: Record<StageName, string> = {
  draft: "Drafting", build: "Building", generate: "Generating", tts: "Recording narration", render: "Rendering", voice: "Mixing voice", sfx: "Adding sound", qa: "Checking quality", repair_scenes: "Repairing scenes",
};

/** Samples needed before a time estimate is shown. */
export const MIN_SAMPLES = 3;
export function median(samples: readonly number[]): number | null {
  if (samples.length < MIN_SAMPLES) return null;
  const s = [...samples].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 === 0 ? `${h} h` : `${h} h ${min % 60} min`;
}
export const estimateLabel = (ms: number | null): string => (ms === null ? "no estimate yet" : `about ${fmtDuration(ms)}`);

export type UiState = "pending" | "running" | "done" | "failed" | "needs_you";
export interface RunFact {
  status: RunStatus;
  createdAt: number;
  updatedAt: number;
  /** 0 for a first try, n for the n-th automatic retry. */
  retryNumber: number;
  error: string | null;
  percent: number | null;
}
export interface StageView {
  stage: StageName;
  label: string;
  state: UiState;
  detail: string;
  percent: number | null;
  timeLeft: string | null;
}

export const STATE_WORDS: Record<UiState, string> = { pending: "Not started", running: "Running", done: "Done", failed: "Failed", needs_you: "Needs you" };

export interface StageGate {
  gate: GateId;
  when: "before" | "after";
}

export function stageViews(i: {
  plan: readonly StageName[];
  gates: Partial<Record<StageName, StageGate>>;
  openGate: GateId | null;
  runs: Partial<Record<StageName, RunFact>>;
  estimates: Partial<Record<StageName, number | null>>;
  maxTries: number;
  now: number;
}): StageView[] {
  return i.plan.map((stage): StageView => {
    const r = i.runs[stage];
    const g = i.gates[stage];
    const label = STAGE_LABELS[stage];
    const percent = r?.percent !== null && r?.percent !== undefined ? Math.max(0, Math.min(100, Math.round(r.percent))) : null;
    const v = (state: UiState, detail: string, timeLeft: string | null = null): StageView => ({ stage, label, state, detail, percent, timeLeft });
    const gateOpen = g && i.openGate === g.gate ? `Waiting for your OK on the ${g.gate}` : null;
    if (!r) return gateOpen && g!.when === "before" ? v("needs_you", gateOpen) : v("pending", "Not started");
    if (r.status === "needs_decision") return v("needs_you", "Waiting for your decision");
    if (r.status === "failed") return v("failed", r.error ?? "Failed");
    if (r.status === "cancelled") return v("failed", "Cancelled");
    if (r.status === "queued") return v("running", r.retryNumber > 0 ? `Waiting on the provider, retry ${r.retryNumber} of ${i.maxTries}` : "Waiting to start");
    if (r.status === "running") {
      const est = i.estimates[stage] ?? null;
      const left = est === null ? null : Math.max(0, est - (i.now - r.createdAt));
      return v("running", `${VERB[stage]}${percent !== null ? ` ${percent}%` : ""}`, left === null ? null : `${estimateLabel(left)} left`);
    }
    return gateOpen && g!.when === "after" ? v("needs_you", gateOpen) : v("done", "Done");
  });
}

/** One plain sentence for the top of the page. */
export function headline(views: readonly StageView[], status: string): string {
  const failed = views.find((s) => s.state === "failed");
  if (failed) return `Stopped at ${failed.label}`;
  const you = views.find((s) => s.state === "needs_you");
  if (you) return `Waiting for you: ${you.label}`;
  const running = views.find((s) => s.state === "running");
  if (running) return `${running.detail}`;
  if (status === "done") return "Finished";
  if (status === "cancelled") return "Cancelled";
  return views.length > 0 && views.every((s) => s.state === "done") ? "All steps done" : "Not started";
}

/** Re-run is only possible for a failed or cancelled step of a video that is still live. */
export const rerunOffered = (runStatus: RunStatus | undefined, videoStatus: string): boolean =>
  (runStatus === "failed" || runStatus === "cancelled") && (videoStatus === "active" || videoStatus === "waiting");

/** What a re-run costs: only the cost plan knows; the generate step is the one paid step it lists. */
export function rerunCostNote(stage: StageName, planTotalMicroUsd: number | null): string {
  if (stage !== "generate") return "Not part of the cost plan: no paid items.";
  return planTotalMicroUsd && planTotalMicroUsd > 0 ? `Costs up to $${microToUsd(planTotalMicroUsd)} (the cost plan's paid items).` : "No paid items in the cost plan.";
}

export type Severity = "info" | "warn" | "block";
export interface QaFinding {
  id: string;
  severity: Severity;
  text: string;
}
export const SEVERITY_WORDS: Record<Severity, { label: string; tone: "neutral" | "warning" | "negative" }> = {
  info: { label: "Note", tone: "neutral" },
  warn: { label: "Check this", tone: "warning" },
  block: { label: "Must fix", tone: "negative" },
};
export function parseFindings(raw: unknown): QaFinding[] {
  if (!Array.isArray(raw)) return [];
  const out: QaFinding[] = [];
  for (const f of raw) {
    if (f && typeof f === "object") {
      const o = f as Record<string, unknown>;
      if (typeof o.id === "string" && typeof o.text === "string" && (o.severity === "info" || o.severity === "warn" || o.severity === "block")) out.push({ id: o.id, severity: o.severity, text: o.text });
    }
  }
  return out;
}
