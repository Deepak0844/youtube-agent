// Claude usage shown to the owner (engine-core spec): a plain line per engine step, and on Health an estimate of how many more
// videos fit in the current 5-hour window. Claude does not tell the window's size, so it is learned from the tokens used in the
// 5 hours before the last time the limit was hit. With no limit seen yet, or fewer than 3 videos, there is no estimate.

export const WINDOW_MS = 5 * 60 * 60 * 1000;

export function estimateVideosLeft(a: { capacityTokens: number | null; usedTokens: number; perVideoTokens: readonly number[] }): number | null {
  if (a.capacityTokens === null || a.perVideoTokens.length < 3) return null;
  const avg = a.perVideoTokens.reduce((x, y) => x + y, 0) / a.perVideoTokens.length;
  if (!(avg > 0)) return null;
  return Math.max(0, Math.floor((a.capacityTokens - a.usedTokens) / avg));
}

import { formatIst, formatMoney } from "@/server/core/display-format";

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function usageLine(u: { inputTokens: number; outputTokens: number; costUsdEquiv: number; turns: number }): string {
  return `Claude: ${k(u.inputTokens + u.outputTokens)} tokens, ${u.turns} turn${u.turns === 1 ? "" : "s"}, about $${u.costUsdEquiv.toFixed(2)} API-equivalent (not billed)`;
}

export interface EngineRunRow {
  id: string;
  stage: string;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
  model: string | null;
  turns: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  costUsdEquiv: number | null;
  durationMs: number | null;
  durationApiMs: number | null;
  toolCalls: Record<string, number>;
  error: string | null;
}

const STATUS_WORDS: Record<string, string> = { running: "Running", succeeded: "Succeeded", failed: "Failed", killed: "Stopped", limit: "Paused by the Claude usage limit" };
const mk = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : k(n));
const minutes = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};

/** "output 61.9k, input 82, cache read 2.4M, cache written 180.0k"; a figure Claude Code did not report is left out. */
function tokenText(t: { output: number | null; input: number | null; cacheRead: number | null; cacheWritten: number | null }): string {
  const parts = [
    t.output !== null ? `output ${mk(t.output)}` : null, t.input !== null ? `input ${mk(t.input)}` : null,
    t.cacheRead !== null ? `cache read ${mk(t.cacheRead)}` : null, t.cacheWritten !== null ? `cache written ${mk(t.cacheWritten)}` : null,
  ].filter((x): x is string => x !== null);
  return parts.length ? parts.join(", ") : "tokens not reported";
}

const money = (usd: number | null, rate: number | null) => (usd === null ? "not reported" : formatMoney(Math.round(usd * 1_000_000), rate));

/** One engine run as plain words for the video page (IST, rupees, "not reported" instead of an invented figure). */
export function engineRunView(r: EngineRunRow, rate: number | null) {
  const tools = Object.entries(r.toolCalls).filter(([, n]) => n > 0).sort((a, b) => (a[0] === "other" ? 1 : b[0] === "other" ? -1 : b[1] - a[1]));
  return {
    id: r.id,
    stage: r.stage,
    when: formatIst(r.startedAt),
    statusWord: STATUS_WORDS[r.status] ?? r.status,
    model: r.model ?? "model not reported",
    turns: r.turns === null ? "turns not reported" : `${r.turns} turn${r.turns === 1 ? "" : "s"}`,
    tokens: tokenText({ output: r.outputTokens, input: r.inputTokens, cacheRead: r.cacheReadTokens, cacheWritten: r.cacheCreationTokens }),
    apiEquivalent: money(r.costUsdEquiv, rate),
    duration: r.endedAt === null ? "still running" : r.durationMs !== null ? minutes(r.durationMs) : minutes(r.endedAt.getTime() - r.startedAt.getTime()),
    tools: tools.length ? tools.map(([n, c]) => `${n} ${c}`).join(", ") : "no tool calls recorded",
    note: r.status === "failed" || r.status === "killed" ? r.error : null,
  };
}

/** The sum over a video's runs. A figure no run reported stays "not reported". */
export function engineTotals(rows: readonly EngineRunRow[], rate: number | null) {
  const sum = (f: (r: EngineRunRow) => number | null) => {
    const xs = rows.map(f).filter((x): x is number => x !== null);
    return xs.length ? xs.reduce((a, b) => a + b, 0) : null;
  };
  const usd = sum((r) => r.costUsdEquiv);
  return {
    runs: rows.length,
    turns: rows.reduce((a, r) => a + (r.turns ?? 0), 0),
    tokens: tokenText({ output: sum((r) => r.outputTokens), input: sum((r) => r.inputTokens), cacheRead: sum((r) => r.cacheReadTokens), cacheWritten: sum((r) => r.cacheCreationTokens) }),
    apiEquivalent: usd === null ? "not reported" : formatMoney(Math.round(usd * 1_000_000), rate),
    duration: minutes(rows.reduce((a, r) => a + (r.durationMs ?? 0), 0)),
    models: [...new Set(rows.map((r) => r.model).filter((m): m is string => m !== null))],
  };
}
