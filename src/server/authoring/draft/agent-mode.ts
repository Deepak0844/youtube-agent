import { MaxStepsError, type Message } from "@/server/core/agent-loop";
import type { StageContext } from "@/server/core/stage-handler";
import { createPgAgentStepStore } from "@/server/db/agent-steps";
import { parseAnswer, type DeclaredTool } from "@/server/llm/client";
import { judgeDraft } from "./evidence-check";
import { agentMessages, fenceUntrusted, rejectionMessage } from "./prompts";
import { DRAFT_MAX_OUTPUT_TOKENS, DraftInvalidError, MAX_DRAFT_RETRIES, rawDraftSchema, type DraftDeps, type DraftInput, type DraftResult, type WebTools } from "./shared";

// Agent mode (Doc 2 §8): the model drives webSearch and fetchPage itself, through the shared agent loop with the Task 16
// checkpoints, so a resumed run replays finished steps and their tools instead of repeating them. Only these two read-only
// tools exist. The same acceptance test as search-then-write applies to the final answer, against the pages that were
// really fetched (read from the tool results in the conversation, which a replay reproduces exactly).

export const AGENT_MAX_STEPS = 12; // one run
export const AGENT_TOTAL_STEPS = 16; // all runs of one Draft together: the paid-call bound, retries included
const URLS_PREFIX = "[urls] ";
const MAX_FENCED_BODY = 12_000;

const wellFormedUrl = (u: unknown): u is string => {
  if (typeof u !== "string" || u.length > 2000 || /\s/.test(u)) return false;
  try {
    const p = new URL(u).protocol;
    return p === "http:" || p === "https:";
  } catch {
    return false;
  }
};

/**
 * The URL list our own wrapper put on the FIRST line inside the fence (the model-visible text after it is untrusted and is
 * never parsed). Anything that is not exactly `[urls] ["..."]` of well-formed http(s) URLs yields nothing.
 */
export function urlsOfSearchOutput(output: string): string[] {
  const lines = output.split("\n");
  if (!lines[0]?.startsWith("<<<DATA") || !lines[1]?.startsWith(URLS_PREFIX)) return [];
  try {
    const v: unknown = JSON.parse(lines[1].slice(URLS_PREFIX.length));
    return Array.isArray(v) && v.every(wellFormedUrl) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

export function draftTools(web: WebTools): DeclaredTool[] {
  const [search, page] = web.tools as [WebTools["tools"][number], WebTools["tools"][number]];
  return [
    {
      ...search,
      description: "Search the web. Returns numbered results with title, URL and snippet.",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      // Results are untrusted data: fenced, with the URLs they returned listed structurally on the first line.
      async run(args) {
        const before = new Set(web.seen);
        const out = await search.run(args);
        const fresh = [...web.seen].filter((u) => !before.has(u));
        return fenceUntrusted("search results", `${URLS_PREFIX}${JSON.stringify(fresh)}\n${out.slice(0, MAX_FENCED_BODY)}`);
      },
      // A resumed run does not repeat the search, so the URLs it returned are remembered again from the checkpoint.
      onReplay: (_args, output) => {
        for (const u of urlsOfSearchOutput(output)) web.seen.add(u);
      },
    },
    {
      ...page,
      description: "Fetch the text of a page. Only a URL returned by webSearch is accepted.",
      inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      async run(args) {
        return fenceUntrusted("page", await page.run(args));
      },
    },
  ];
}

/** The page text inside a fetchPage result's fence (what the model saw), or null when it is not a fenced page. */
function unfence(content: string): string | null {
  const m = /^<<<DATA page\n([\s\S]*)\n>>>$/.exec(content);
  return m ? m[1]! : null;
}

/** url -> page text, for every fetchPage call in the conversation that returned a page (tool errors are skipped). */
export function fetchedPages(messages: Message[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== "assistant" || !m.toolCalls?.length) continue;
    m.toolCalls.forEach((c, k) => {
      const reply = messages[i + 1 + k];
      const url = (c.args as { url?: unknown } | null)?.url;
      if (c.name !== "fetchPage" || typeof url !== "string" || reply?.role !== "tool") return;
      const text = unfence(reply.content);
      if (text !== null) out.set(url, text);
    });
  }
  return out;
}

export async function agentDraft(ctx: StageContext, deps: DraftDeps, input: DraftInput & { format: "short" | "long" }): Promise<DraftResult> {
  const store = deps.store === undefined ? createPgAgentStepStore(deps.db, ctx.stage.id) : deps.store;
  const tools = draftTools(deps.web);
  let messages: Message[] = agentMessages({ topic: input.topic, lang: input.lang, kind: input.kind, format: input.format, notes: input.notes, feedback: input.feedback });
  let spent = 0;
  let stepsLeft = AGENT_TOTAL_STEPS;

  for (let attempt = 0; ; attempt++) {
    if (stepsLeft < 1) throw new DraftInvalidError(["the model used all its steps without a valid draft"], spent);
    const maxSteps = Math.min(AGENT_MAX_STEPS, stepsLeft);
    let run;
    try {
      run = await deps.llm.agent(ctx, { stage: "draft", tools, messages, maxSteps, maxOutputTokens: DRAFT_MAX_OUTPUT_TOKENS, ...(store ? { checkpoint: { claim: ctx.claim, store, runOrdinal: attempt } } : {}) });
    } catch (err) {
      if (err instanceof MaxStepsError) throw new DraftInvalidError([`the model did not finish within ${maxSteps} steps`], spent);
      throw err;
    }
    spent += run.spentMicroUsd;
    stepsLeft -= run.steps;
    const fetched = fetchedPages(run.messages);
    const parsed = parseAnswer(run.text, rawDraftSchema);
    const verdict = parsed.ok ? judgeDraft(parsed.value, input.lang, input.format, fetched) : { ok: false as const, problems: [parsed.reason] };
    if (verdict.ok) return { script: verdict.script, spentMicroUsd: spent };
    if (attempt >= MAX_DRAFT_RETRIES) throw new DraftInvalidError(verdict.problems, spent);
    messages = [...run.messages, { role: "user", content: rejectionMessage(verdict.problems, [...fetched.keys()]) }];
  }
}
