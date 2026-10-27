import { z } from "zod";
import { hashToolArgs, sanitizeToolOutput, type AgentStepStore, type Message } from "@/server/core/agent-loop";
import type { StageContext } from "@/server/core/stage-handler";
import { createPgAgentStepStore } from "@/server/db/agent-steps";
import { LeaseLostError } from "@/server/core/paid-call";
import { judgeDraft } from "./evidence-check";
import { queriesMessages, rejectionMessage, writeMessages, type PageExcerpt } from "./prompts";
import { DRAFT_MAX_OUTPUT_TOKENS, DraftInvalidError, MAX_DRAFT_RETRIES, rawDraftSchema, type DraftDeps, type DraftInput, type DraftResult, type WebTools } from "./shared";

// Search-then-write (Doc 2 §8): for models that cannot run a tool loop. The model is never given a tool. Call 1 returns
// search queries; the APP runs them and fetches at most 6 distinct pages (only URLs the search returned); call 2 writes
// the script from numbered excerpts. A rejected draft is retried up to twice with a precise problem list.

const queriesSchema = z.strictObject({ queries: z.array(z.string().trim().min(1).max(300)).min(1).max(4) });
export const MAX_PAGES = 6;
const EXCERPT_CHARS = 4500; // small enough that a page (even in a 3-byte script) fits the 16 KB checkpoint row
// Checkpoint slot for the gathered pages: far above any agent step (runOrdinal * 1000 + step), so they can never collide.
export const PAGES_STEP = 1_500_000_000;

/**
 * The pages the write call is judged against are saved the first time they are gathered and reused on a resume. The write
 * call itself replays from storage, so its answer must be judged against the SAME pages; searching again could return other
 * pages and burn the retries on a draft that was fine.
 */
async function loadPages(store: AgentStepStore | null, step: number): Promise<PageExcerpt[] | null> {
  const rows = store ? await store.loadOutputs(step) : null;
  if (!rows) return null;
  const pages: PageExcerpt[] = [];
  for (const [, r] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
    if (r.toolName === "none") continue;
    try {
      const v = JSON.parse(r.output) as { url?: unknown; text?: unknown };
      if (typeof v.url !== "string" || typeof v.text !== "string") return null;
      pages.push({ url: v.url, text: v.text });
    } catch {
      return null; // unreadable: gather again rather than judge against a guess
    }
  }
  return pages;
}

async function savePages(ctx: StageContext, store: AgentStepStore | null, step: number, pages: PageExcerpt[]): Promise<PageExcerpt[]> {
  if (!store) return pages;
  const outs = pages.length
    ? pages.map((p, index) => ({ index, toolCallId: "page", toolName: "page", argsHash: hashToolArgs({ url: p.url }), output: JSON.stringify({ url: p.url, text: p.text }) }))
    : [{ index: 0, toolCallId: "none", toolName: "none", argsHash: hashToolArgs(null), output: "none" }];
  const saved = await store.saveOutputs(ctx.claim, step, outs);
  if (!saved) throw new LeaseLostError(`draft pages:${ctx.claim.stageRunId}`);
  return (await loadPages(store, step)) ?? pages;
}

async function gatherPages(web: WebTools, queries: string[], signal: AbortSignal): Promise<PageExcerpt[]> {
  const search = web.tools.find((t) => t.name === "webSearch")!;
  const fetchPage = web.tools.find((t) => t.name === "fetchPage")!;
  const urls: string[] = [];
  for (const query of [...new Set(queries)]) {
    signal.throwIfAborted();
    const before = new Set(web.seen);
    try {
      await search.run({ query });
    } catch {
      continue; // one failed search does not stop the draft
    }
    for (const u of web.seen) if (!before.has(u) && !urls.includes(u)) urls.push(u);
  }
  const pages: PageExcerpt[] = [];
  for (const url of urls.slice(0, MAX_PAGES)) {
    signal.throwIfAborted();
    try {
      // The same cleaned text goes to the model and to the quote check.
      const text = sanitizeToolOutput((await fetchPage.run({ url })).slice(0, EXCERPT_CHARS));
      if (text.trim() !== "") pages.push({ url, text });
    } catch {
      /* an unreachable page is simply not used */
    }
  }
  return pages;
}

export async function searchThenWrite(ctx: StageContext, deps: DraftDeps, input: DraftInput & { format: "short" | "long" }): Promise<DraftResult> {
  const prompt = { topic: input.topic, lang: input.lang, kind: input.kind, format: input.format, notes: input.notes, feedback: input.feedback };
  const q = await deps.llm.generate(ctx, { stage: "draft", schema: queriesSchema, messages: queriesMessages(prompt), maxOutputTokens: 400, invalidRetries: 1 });
  let spent = q.spentMicroUsd;

  const store = deps.store === undefined ? createPgAgentStepStore(deps.db, ctx.stage.id) : deps.store;
  const pages = (await loadPages(store, PAGES_STEP)) ?? (await savePages(ctx, store, PAGES_STEP, await gatherPages(deps.web, q.value.queries, ctx.signal)));
  const fetched = new Map(pages.map((p) => [p.url, p.text] as const));
  const messages: Message[] = writeMessages({ ...prompt, pages });

  for (let attempt = 0; ; attempt++) {
    const w = await deps.llm.generate(ctx, { stage: "draft", schema: rawDraftSchema, messages, maxOutputTokens: DRAFT_MAX_OUTPUT_TOKENS, invalidRetries: 1 });
    spent += w.spentMicroUsd;
    const verdict = judgeDraft(w.value, input.lang, input.format, fetched);
    if (verdict.ok) return { script: verdict.script, spentMicroUsd: spent };
    if (attempt >= MAX_DRAFT_RETRIES) throw new DraftInvalidError(verdict.problems, spent);
    messages.push({ role: "assistant", content: JSON.stringify(w.value).slice(0, 4000), toolCalls: [] });
    messages.push({ role: "user", content: rejectionMessage(verdict.problems, [...fetched.keys()]) });
  }
}
