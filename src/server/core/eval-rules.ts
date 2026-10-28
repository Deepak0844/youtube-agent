// Rules of the per-model Draft eval (Doc 08 section 6). Pure: no IO.
// The eval measures reliability and cost, not taste. Agent mode is used only on a model that proved it on the full fixed
// topic set; everything else (never evaluated, partial run, a worse newer run) is the safe search-then-write mode.

export type DraftModeName = "agent" | "search_then_write";

export const FULL_TOPIC_SET = 10;
export const AGENT_MIN_VALID = 8;

export interface EvalRunSummary {
  modeTested: DraftModeName;
  startedAt: Date | string | number;
  topics: number;
  valid: number;
  evidenceValid: number;
  costMicroUsd: number;
}

const ms = (t: EvalRunSummary["startedAt"]): number => new Date(t).getTime();

/** True only for a complete, internally consistent agent run with at least 8 of the 10 topics fully valid. */
function provesAgent(r: EvalRunSummary): boolean {
  return (
    r.modeTested === "agent" &&
    Number.isInteger(r.topics) &&
    Number.isInteger(r.valid) &&
    Number.isInteger(r.evidenceValid) &&
    r.topics === FULL_TOPIC_SET &&
    r.evidenceValid >= AGENT_MIN_VALID &&
    r.valid >= r.evidenceValid &&
    r.valid <= r.topics
  );
}

/** The latest agent-mode run (by start time; the later entry wins a tie), or undefined. */
export function latestAgentRun<T extends EvalRunSummary>(runs: readonly T[]): T | undefined {
  let best: T | undefined;
  for (const r of runs) {
    if (r.modeTested !== "agent" || Number.isNaN(ms(r.startedAt))) continue;
    if (!best || ms(r.startedAt) >= ms(best.startedAt)) best = r;
  }
  return best;
}

/** `agent` only if the latest agent-mode run was a full run with 8+ of 10 fully valid. An older, better run never counts. */
export function decideDraftMode(runs: readonly EvalRunSummary[]): DraftModeName {
  const latest = latestAgentRun(runs);
  return latest && provesAgent(latest) ? "agent" : "search_then_write";
}

export interface Badge {
  mode: DraftModeName;
  label: string;
  detail: string;
  at: Date;
  costMicroUsd: number;
}

/** What the models page shows: the verdict of decideDraftMode plus the run it came from. null = never evaluated. */
export function badgeFor(runs: readonly EvalRunSummary[]): Badge | null {
  if (runs.length === 0) return null;
  const mode = decideDraftMode(runs);
  const agent = latestAgentRun(runs);
  if (mode === "agent" && agent) {
    return { mode, label: `agent mode proven ${agent.evidenceValid}/${agent.topics}`, detail: "", at: new Date(agent.startedAt), costMicroUsd: agent.costMicroUsd };
  }
  const shown = agent ?? [...runs].sort((a, b) => ms(a.startedAt) - ms(b.startedAt)).at(-1)!;
  const detail = shown.modeTested === "agent" ? `agent run ${shown.evidenceValid}/${shown.topics}` : `search-then-write run ${shown.evidenceValid}/${shown.topics}`;
  return { mode, label: "search-then-write", detail, at: new Date(shown.startedAt), costMicroUsd: shown.costMicroUsd };
}

/**
 * A refused draft names its problems; evidence problems all start with "claim N:" (evidence-check.ts). If every problem is
 * an evidence problem the script itself passed the contract.
 */
export function classifyFailure(problems: readonly string[]): { scriptValid: boolean } {
  return { scriptValid: problems.length > 0 && problems.every((p) => /^claim \d+:/.test(p)) };
}

/** The most one eval run may spend: the lower of the seeded `eval` cap and the script's own --max-usd. */
export function evalCeilingMicroUsd(evalCapMicroUsd: number, maxUsd: number): number {
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new RangeError("--max-usd must be a positive number");
  return Math.min(evalCapMicroUsd, Math.floor(maxUsd * 1_000_000));
}

export function p50(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}
