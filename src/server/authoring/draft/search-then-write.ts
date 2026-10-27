import { z } from "zod";
import { sanitizeToolOutput, type Message } from "@/server/core/agent-loop";
import type { StageContext } from "@/server/core/stage-handler";
import { judgeDraft } from "./evidence-check";
import { queriesMessages, rejectionMessage, writeMessages, type PageExcerpt } from "./prompts";
import { DRAFT_MAX_OUTPUT_TOKENS, DraftInvalidError, MAX_DRAFT_RETRIES, rawDraftSchema, type DraftDeps, type DraftInput, type DraftResult, type WebTools } from "./shared";

// Search-then-write (Doc 2 §8): for models that cannot run a tool loop. The model is never given a tool. Call 1 returns
// search queries; the APP runs them and fetches at most 6 distinct pages (only URLs the search returned); call 2 writes
// the script from numbered excerpts. A rejected draft is retried up to twice with a precise problem list.

const queriesSchema = z.strictObject({ queries: z.array(z.string().trim().min(1).max(300)).min(1).max(4) });
export const MAX_PAGES = 6;

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
      const text = sanitizeToolOutput(await fetchPage.run({ url }));
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

  const pages = await gatherPages(deps.web, q.value.queries, ctx.signal);
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
