import { MaxStepsError, type Message } from "@/server/core/agent-loop";
import type { StageContext } from "@/server/core/stage-handler";
import { createPgAgentStepStore } from "@/server/db/agent-steps";
import { parseAnswer, type DeclaredTool } from "@/server/llm/client";
import { judgeDraft } from "./evidence-check";
import { agentMessages, rejectionMessage } from "./prompts";
import { DRAFT_MAX_OUTPUT_TOKENS, DraftInvalidError, MAX_DRAFT_RETRIES, rawDraftSchema, type DraftDeps, type DraftInput, type DraftResult, type WebTools } from "./shared";

// Agent mode (Doc 2 §8): the model drives webSearch and fetchPage itself, through the shared agent loop with the Task 16
// checkpoints, so a resumed run replays finished steps and their tools instead of repeating them. Only these two read-only
// tools exist. The same acceptance test as search-then-write applies to the final answer, against the pages that were
// really fetched (read from the tool results in the conversation, which a replay reproduces exactly).

export const AGENT_MAX_STEPS = 12;

/** URLs on the second line of each "N. title / url / snippet" block of a search result. */
function urlsOfSearchOutput(output: string): string[] {
  const out: string[] = [];
  for (const block of output.split("\n\n")) {
    const url = block.split("\n")[1]?.trim();
    if (url && /^https?:\/\/\S+$/.test(url)) out.push(url);
  }
  return out;
}

export function draftTools(web: WebTools): DeclaredTool[] {
  const [search, page] = web.tools as [WebTools["tools"][number], WebTools["tools"][number]];
  return [
    {
      ...search,
      description: "Search the web. Returns numbered results with title, URL and snippet.",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      // A resumed run does not repeat the search, so the URLs it returned are remembered again from the checkpoint.
      onReplay: (_args, output) => {
        for (const u of urlsOfSearchOutput(output)) web.seen.add(u);
      },
    },
    {
      ...page,
      description: "Fetch the text of a page. Only a URL returned by webSearch is accepted.",
      inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
  ];
}

/** url -> page text, for every fetchPage call in the conversation that returned text (tool errors are skipped). */
export function fetchedPages(messages: Message[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== "assistant" || !m.toolCalls?.length) continue;
    m.toolCalls.forEach((c, k) => {
      const reply = messages[i + 1 + k];
      const url = (c.args as { url?: unknown } | null)?.url;
      if (c.name === "fetchPage" && typeof url === "string" && reply?.role === "tool" && !reply.content.startsWith("error:")) out.set(url, reply.content);
    });
  }
  return out;
}

export async function agentDraft(ctx: StageContext, deps: DraftDeps, input: DraftInput & { format: "short" | "long" }): Promise<DraftResult> {
  const store = deps.store === undefined ? createPgAgentStepStore(deps.db, ctx.stage.id) : deps.store;
  const tools = draftTools(deps.web);
  let messages: Message[] = agentMessages({ topic: input.topic, lang: input.lang, kind: input.kind, format: input.format, notes: input.notes, feedback: input.feedback });
  let spent = 0;

  for (let attempt = 0; ; attempt++) {
    let run;
    try {
      run = await deps.llm.agent(ctx, { stage: "draft", tools, messages, maxSteps: AGENT_MAX_STEPS, maxOutputTokens: DRAFT_MAX_OUTPUT_TOKENS, ...(store ? { checkpoint: { claim: ctx.claim, store, runOrdinal: attempt } } : {}) });
    } catch (err) {
      if (err instanceof MaxStepsError) throw new DraftInvalidError([`the model did not finish within ${AGENT_MAX_STEPS} steps`], spent);
      throw err;
    }
    spent += run.spentMicroUsd;
    const fetched = fetchedPages(run.messages);
    const parsed = parseAnswer(run.text, rawDraftSchema);
    const verdict = parsed.ok ? judgeDraft(parsed.value, input.lang, input.format, fetched) : { ok: false as const, problems: [parsed.reason] };
    if (verdict.ok) return { script: verdict.script, spentMicroUsd: spent };
    if (attempt >= MAX_DRAFT_RETRIES) throw new DraftInvalidError(verdict.problems, spent);
    messages = [...run.messages, { role: "user", content: rejectionMessage(verdict.problems, [...fetched.keys()]) }];
  }
}
