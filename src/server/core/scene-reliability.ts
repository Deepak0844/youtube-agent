import type { Message } from "@/server/core/agent-loop";
import { BudgetRefusedError, KnownFailure } from "@/server/core/paid-call";
import { describeSceneFormat, sceneJsonSchema, validateScenes } from "@/shared/scene";
import type { kinds } from "@/shared/scene/kinds";

// Scene-JSON reliability check (Phase 4): can a model fill the scene format from a beat sheet? Pure loop: the caller's `ask`
// does the paid, reserved model call. A schema-invalid answer is retried (max 2) with the plain-text errors fed back; the same
// error twice in a row stops the retries. A call whose outcome is unclear is never retried: the whole run stops there.

export const MAX_RETRIES = 2;
export const GO_RATIO = 0.8;
const ASSET_KINDS = new Set<string>(["story_kenburns", "stock_clip", "collage", "browser"]);

/** Which sheets to run: `perKind` = first n of each kind (file order); else the first `runs` (default 10). */
export function selectSheets(all: BeatSheet[], o: { runs?: number; perKind?: number; kinds?: string[] }): BeatSheet[] {
  if (o.kinds) all = all.filter((s) => o.kinds!.includes(s.kind));
  if (o.perKind === undefined) return all.slice(0, o.runs ?? 10);
  const seen = new Map<string, number>();
  return all.filter((s) => {
    const n = seen.get(s.kind) ?? 0;
    seen.set(s.kind, n + 1);
    return n < o.perKind!;
  });
}

export interface BeatSheet {
  id: string;
  kind: keyof typeof kinds;
  beats: { id: string; text: string }[];
}
export interface AskResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
}
export type Ask = (messages: Message[], sheet: BeatSheet) => Promise<AskResult>;

export interface SheetResult {
  id: string;
  kind: BeatSheet["kind"];
  firstTry: boolean;
  withinRetries: boolean;
  attempts: number;
  errors: string[];
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
  /** The provider refused the first call (nothing sent or charged). */
  refused?: string;
}
export type Stopped = "none" | "cap" | "unclear" | "aborted";

export function buildMessages(s: BeatSheet): Message[] {
  const system = [
    "You turn a beat sheet into scene JSON for a short portrait video.",
    describeSceneFormat(),
    `JSON Schema:\n${JSON.stringify(sceneJsonSchema())}`,
    "Use one scene per beat, in order, starting at 0 ms. Reply with only the JSON, no commentary.",
  ].join("\n\n");
  const lines = s.beats.map((b) => `- ${b.id}: ${b.text}`).join("\n");
  const hint = ASSET_KINDS.has(s.kind) ? "\nUse the image asset ids img_1, img_2, img_3." : "";
  return [
    { role: "system", content: system },
    { role: "user", content: `Preferred scene kind: ${s.kind}\nBeats:\n${lines}${hint}` },
  ];
}

function check(text: string): string[] {
  const t = text.trim();
  const body = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t)?.[1] ?? t;
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return ["The answer was not valid JSON."];
  }
  const r = validateScenes(raw);
  return r.ok ? [] : r.errors;
}

export async function runSheets(sheets: BeatSheet[], ask: Ask, opts: { signal?: AbortSignal } = {}): Promise<{ results: SheetResult[]; stopped: Stopped }> {
  const results: SheetResult[] = [];
  for (const sheet of sheets) {
    if (opts.signal?.aborted) return { results, stopped: "aborted" };
    const messages = buildMessages(sheet);
    const r: SheetResult = { id: sheet.id, kind: sheet.kind, firstTry: false, withinRetries: false, attempts: 0, errors: [], inputTokens: 0, outputTokens: 0, costMicroUsd: 0 };
    let prev = "";
    for (let a = 0; a <= MAX_RETRIES; a++) {
      let res: AskResult;
      try {
        res = await ask(messages, sheet);
      } catch (err) {
        if (err instanceof KnownFailure) {
          r.errors.push(err.message);
          if (r.attempts === 0) r.refused = err.message;
          break;
        }
        if (r.attempts > 0) results.push(r);
        return { results, stopped: err instanceof BudgetRefusedError ? "cap" : "unclear" };
      }
      r.attempts++;
      r.inputTokens += res.inputTokens;
      r.outputTokens += res.outputTokens;
      r.costMicroUsd += res.costMicroUsd;
      const errors = check(res.text);
      if (errors.length === 0) {
        r.firstTry = a === 0;
        r.withinRetries = true;
        break;
      }
      r.errors.push(...errors);
      const key = errors.join("\n");
      if (key === prev || a === MAX_RETRIES) break;
      prev = key;
      messages.push({ role: "assistant", content: res.text.slice(0, 4000), toolCalls: [] });
      messages.push({ role: "user", content: `Your JSON was rejected:\n${errors.join("\n")}\nReply again with only the corrected JSON.` });
    }
    results.push(r);
  }
  return { results, stopped: "none" };
}

export function summarize(results: SheetResult[], planned: number, stopped: Stopped = "none") {
  const firstTry = results.filter((r) => r.firstTry).length;
  const withinRetries = results.filter((r) => r.withinRetries).length;
  const byKind: Record<string, { ran: number; firstTry: number; withinRetries: number }> = {};
  for (const r of results) {
    const k = (byKind[r.kind] ??= { ran: 0, firstTry: 0, withinRetries: 0 });
    k.ran++;
    if (r.firstTry) k.firstTry++;
    if (r.withinRetries) k.withinRetries++;
  }
  const counts = new Map<string, number>();
  for (const r of results) for (const e of r.errors) counts.set(e.replace(/\d+/g, "N"), (counts.get(e.replace(/\d+/g, "N")) ?? 0) + 1);
  const topErrors = [...counts].map(([message, count]) => ({ message, count })).sort((a, b) => b.count - a.count).slice(0, 5);
  const notRun = results.length > 0 && results.every((r) => r.refused !== undefined);
  return {
    notRunReason: notRun ? results[0]!.refused! : undefined,
    planned,
    ran: results.length,
    firstTry,
    withinRetries,
    costMicroUsd: results.reduce((s, r) => s + r.costMicroUsd, 0),
    stopped,
    verdict: notRun
      ? ("NOT RUN" as const)
      : results.length < planned && results.length - withinRetries <= planned - Math.ceil(planned * GO_RATIO)
        ? ("INCOMPLETE" as const)
        : planned > 0 && withinRetries >= Math.ceil(planned * GO_RATIO) ? ("GO" as const) : ("NO-GO" as const),
    byKind,
    topErrors,
  };
}
