import type { LanguageModel } from "ai";
import type pg from "pg";
import type { z } from "zod";
import {
  estimateInputTokens,
  runAgent,
  type AgentResult,
  type AgentStepStore,
  type AgentTool,
  type Message,
  type ModelStep,
  type PayStep,
  type StepResult,
} from "@/server/core/agent-loop";
import { STAGES, checkModelUsable, eligibleForStage, microToUsd, priceCardFor, type ModelRow } from "@/server/core/llm-catalog";
import { KnownFailure, type ClaimLike } from "@/server/core/paid-call";
import { worstCaseMicroUsd, type PriceCard } from "@/server/core/spend";
import { getModel, listRoutes, localServices } from "@/server/db/llm-models";
import { createAiSdkStep, type ToolDecl } from "./ai-sdk-step";

// The one door to a language model for stage code (Doc 08 section 2-3).
//
// - A stage uses the model routed to it, and only that model. A missing route, a disabled model, an unpriced model and a
//   model that cannot do the stage are refused with a plain sentence BEFORE anything is reserved or sent. There is no
//   fallback to another model or provider, ever.
// - Every model call is one `ctx.paid` step: its own call key and its own worst-case reservation. A schema-invalid answer is
//   retried (default twice) with the problem fed back; each retry is a real counted, reserved, settled call, so there is
//   no hidden spend. A call whose outcome is unclear is never retried here: the error goes up and the stage parks.
// - Keys are fetched lazily inside the request by the model factory, per call, and never held here.

/** A refusal that happened before any money moved. A KnownFailure: the stage fails with this sentence, nothing is retried. */
export class LlmRefusal extends KnownFailure {
  constructor(message: string) {
    super(message);
    this.name = "LlmRefusal";
  }
}

/** The part of the stage context the client needs. The engine's StageContext satisfies it. */
export interface LlmStageContext {
  signal: AbortSignal;
  paid: PayStep;
}

/** Where routes and models are read. The default reads Postgres; tests pass their own. */
export interface LlmCatalog {
  route(stage: string): Promise<ModelRow | undefined>;
  localServices(): Promise<string[]>;
}

export function pgCatalog(db: pg.Pool): LlmCatalog {
  return {
    async route(stage) {
      const id = (await listRoutes(db))[stage];
      return id === undefined ? undefined : getModel(db, id);
    },
    localServices: () => localServices(db),
  };
}

export type DeclaredTool = AgentTool & Omit<ToolDecl, "name">;

export interface LlmClient {
  generate<T>(
    ctx: LlmStageContext,
    a: { stage: string; schema: z.ZodType<T>; messages: Message[]; maxOutputTokens: number; invalidRetries?: 0 | 1 | 2 },
  ): Promise<{ value: T; spentMicroUsd: number }>;
  agent(
    ctx: LlmStageContext,
    a: {
      stage: string;
      tools: DeclaredTool[];
      messages: Message[];
      maxSteps: number;
      maxOutputTokens: number;
      /** Tool-output checkpoints (Task 16): a resumed run replays finished steps. runOrdinal must differ for each agent run in one stage. */
      checkpoint?: { claim: ClaimLike; store: AgentStepStore; runOrdinal: number };
    },
  ): Promise<AgentResult>;
}

export interface LlmClientDeps {
  db: pg.Pool;
  /** Called by the model factory inside each request. */
  getKey(provider: string): Promise<string | null>;
  buildModel(row: ModelRow, getKey: () => Promise<string | null>): LanguageModel;
  /** Budget scopes this stage's calls are reserved against (the video's `video:<kind>`, `day`, `month`, `draft_run` for Draft). */
  budgetScopes(ctx: LlmStageContext): string[];
  catalog?: LlmCatalog;
  /** Tests only. */
  makeStep?(model: LanguageModel, decls: ToolDecl[], maxOutputTokens: number): ModelStep;
}

const MAX_FEEDBACK_ECHO = 4000; // characters of the rejected answer shown back to the model
const MAX_ISSUES = 5;

function stageLabel(stage: string): string {
  return STAGES.find((s) => s.id === stage)?.label ?? stage;
}

/** Pulls the JSON text out of an answer (a code fence around it is tolerated). */
function jsonText(answer: string): string {
  const t = answer.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  return fenced ? fenced[1]! : t;
}

/** Parses and validates an answer. On failure the reason names schema paths and rules only, never text the model wrote (values or key names). */
export function parseAnswer<T>(answer: string, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false; reason: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText(answer));
  } catch {
    return { ok: false, reason: "The answer was not valid JSON." };
  }
  const r = schema.safeParse(raw);
  if (r.success) return { ok: true, value: r.data };
  // Fed back to the model, so nothing the model wrote may come back out: an unrecognised key is reported without its name
  // (zod's own message quotes it), and only schema-defined paths and messages are used.
  const lines = r.error.issues.slice(0, MAX_ISSUES).map((i) => {
    const where = i.path.length ? i.path.join(".") : "(root)";
    return i.code === "unrecognized_keys" ? `${where}: has a field that is not allowed` : `${where}: ${i.message.slice(0, 120)}`;
  });
  return { ok: false, reason: `The JSON did not match the required shape. ${lines.join("; ")}` };
}

export function createLlmClient(deps: LlmClientDeps): LlmClient {
  const catalog = deps.catalog ?? pgCatalog(deps.db);
  const makeStep = deps.makeStep ?? createAiSdkStep;

  async function resolve(stage: string, needTools: boolean): Promise<{ row: ModelRow; model: LanguageModel; price: PriceCard }> {
    if (!STAGES.some((s) => s.id === stage)) throw new LlmRefusal("Unknown stage.");
    const row = await catalog.route(stage);
    if (!row) throw new LlmRefusal(`No model is chosen for ${stageLabel(stage)}. Pick one on the Models page.`);
    const local = await catalog.localServices();
    const usable = checkModelUsable(row, local);
    if (!usable.ok) throw new LlmRefusal(`${row.label}: ${usable.reason}`);
    const fit = eligibleForStage(stage, row);
    if (!fit.ok) throw new LlmRefusal(`${row.label} lacks: ${fit.missing.join(", ")}.`);
    if (needTools && !row.capabilities.toolUse) throw new LlmRefusal(`${row.label} lacks: tool use.`);
    const price = priceCardFor(row, local)!; // checkModelUsable proved a card exists
    let model: LanguageModel;
    try {
      model = deps.buildModel(row, () => deps.getKey(row.provider));
    } catch (err) {
      // The factory's own sentences ("That base URL cannot be used...", "needs a base URL"): fixed text, no secret.
      throw new LlmRefusal(err instanceof Error ? err.message : "The model could not be set up.");
    }
    return { row, model, price };
  }

  return {
    async generate(ctx, a) {
      const retries = Math.min(2, Math.max(0, Math.trunc(a.invalidRetries ?? 2))) as 0 | 1 | 2;
      const { row, model, price } = await resolve(a.stage, false);
      const step = makeStep(model, [], a.maxOutputTokens);
      const scopes = deps.budgetScopes(ctx);
      const messages = [...a.messages];
      let spent = 0;

      for (let attempt = 0; attempt <= retries; attempt++) {
        ctx.signal.throwIfAborted();
        const snapshot = [...messages];
        // Throws UnpricedCallError if the price card cannot cover the usage: nothing reserved, nothing sent.
        const reserveMicroUsd = worstCaseMicroUsd(price, { inputTokens: estimateInputTokens(snapshot), maxOutputTokens: a.maxOutputTokens });
        const res = await ctx.paid<StepResult>({ reserveMicroUsd, budgetScopes: scopes, kind: "paid" }, async (key, signal) => {
          const result = await step(snapshot, key, signal);
          const actualMicroUsd = worstCaseMicroUsd(price, { inputTokens: result.usage.inputTokens, maxOutputTokens: result.usage.outputTokens });
          return { result, actualMicroUsd };
        });
        spent += worstCaseMicroUsd(price, { inputTokens: res.usage.inputTokens, maxOutputTokens: res.usage.outputTokens });

        const parsed = parseAnswer(res.text, a.schema);
        if (parsed.ok) return { value: parsed.value, spentMicroUsd: spent };
        if (attempt === retries) {
          throw new KnownFailure(
            `${row.label} did not return the required format after ${attempt + 1} ${attempt === 0 ? "try" : "tries"}. ` +
              `The cost of those tries (${microToUsd(spent)} USD) was counted. ${parsed.reason}`,
          );
        }
        messages.push({ role: "assistant", content: res.text.slice(0, MAX_FEEDBACK_ECHO), toolCalls: [] });
        messages.push({ role: "user", content: `Your previous answer was rejected. ${parsed.reason} Reply again with only the corrected JSON.` });
      }
      throw new Error("unreachable");
    },

    async agent(ctx, a) {
      const { model, price } = await resolve(a.stage, true);
      const decls: ToolDecl[] = a.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
      return runAgent({
        paid: ctx.paid,
        price,
        budgetScopes: deps.budgetScopes(ctx),
        maxOutputTokens: a.maxOutputTokens,
        maxSteps: a.maxSteps,
        step: makeStep(model, decls, a.maxOutputTokens),
        tools: a.tools,
        messages: a.messages,
        signal: ctx.signal,
        ...(a.checkpoint ? { claim: a.checkpoint.claim, store: a.checkpoint.store, runOrdinal: a.checkpoint.runOrdinal } : {}),
      });
    },
  };
}
