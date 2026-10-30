import type { LanguageModel } from "ai";
import type pg from "pg";
import { z } from "zod";
import beatsJson from "../../../scripts/fixtures/scene-beats.json";
import type { ModelStep } from "@/server/core/agent-loop";
import { buildEngineConfig } from "@/server/core/engine-config";
import { evalCeilingMicroUsd } from "@/server/core/eval-rules";
import { checkModelUsable, eligibleForStage, priceCardFor, type ModelRow } from "@/server/core/llm-catalog";
import { createStageContext } from "@/server/core/stage-handler";
import { kinds } from "@/shared/scene/kinds";
import { runSheets, selectSheets, summarize, type Ask, type BeatSheet, type SheetResult, type Stopped } from "@/server/core/scene-reliability";
import { evalCap, evalScopes, EvalRefusal, openEvalStage } from "@/server/db/llm-eval";
import { getModel, localServices } from "@/server/db/llm-models";
import { createPgPaidCallPorts } from "@/server/db/paid-call-adapter";
import { commitStage } from "@/server/db/stages";
import { uuidv7 } from "@/server/core/ids";
import { createAiSdkStep, type ToolDecl } from "@/server/llm/ai-sdk-step";
import { createLlmClient } from "@/server/llm/client";

// Owner-run scene-JSON reliability eval (npm run eval:scenes). Same money rules as llm-eval: owner terminal only, --yes after the
// ceiling is printed, every call reserved first against a per-run copy of the `eval` budget (lowered to --max-usd), unclear
// outcomes park. Writes nothing to the database apart from the paid-call ledger rows.

export const HARD_MAX_USD = 2;
const MAX_OUTPUT_TOKENS = 3000;

const sheetsSchema = z.array(
  z.strictObject({
    id: z.string().min(1),
    kind: z.enum(Object.keys(kinds) as [keyof typeof kinds, ...(keyof typeof kinds)[]]),
    beats: z.array(z.strictObject({ id: z.string().min(1), text: z.string().min(1) })).min(1),
  }),
);
export const fixedSheets = (): BeatSheet[] => sheetsSchema.parse(beatsJson);

export interface SceneEvalRequest {
  modelId: string;
  runs?: number;
  /** Pick n sheets from each kind instead of the first `runs`. */
  perKind?: number;
  /** Only these kinds. */
  kinds?: string[];
  maxUsd?: number;
}
export interface SceneEvalDeps {
  getKey(provider: string): Promise<string | null>;
  buildModel(row: ModelRow, getKey: () => Promise<string | null>): LanguageModel;
  signal?: AbortSignal;
  /** Tests only. */
  makeStep?(model: LanguageModel, decls: ToolDecl[], maxOutputTokens: number): ModelStep;
}

export async function planSceneEval(db: pg.Pool, req: SceneEvalRequest) {
  if (typeof req.modelId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.modelId)) throw new EvalRefusal("Give the model id of the model to test.");
  const all = fixedSheets();
  const bad = (req.kinds ?? []).filter((k) => !Object.keys(kinds).includes(k));
  if (bad.length || req.kinds?.length === 0) throw new EvalRefusal(`--kinds: unknown kind ${bad.join(", ") || "(none given)"}. Known kinds: ${Object.keys(kinds).join(", ")}.`);
  const n = req.runs ?? 10;
  if (!Number.isInteger(n) || n < 1 || n > all.length) throw new EvalRefusal(`--runs must be a whole number from 1 to ${all.length}.`);
  if (req.perKind !== undefined && (!Number.isInteger(req.perKind) || req.perKind < 1)) throw new EvalRefusal("--per-kind must be a whole number, 1 or more.");
  const maxUsd = req.maxUsd ?? 0.5;
  if (!Number.isFinite(maxUsd) || maxUsd <= 0 || maxUsd > HARD_MAX_USD) throw new EvalRefusal(`--max-usd must be above 0 and at most ${HARD_MAX_USD}.`);
  const model = await getModel(db, req.modelId);
  if (!model) throw new EvalRefusal("Unknown model.");
  const local = await localServices(db);
  const usable = checkModelUsable(model, local);
  if (!usable.ok) throw new EvalRefusal(`${model.label}: ${usable.reason}`);
  if (!priceCardFor(model, local)) throw new EvalRefusal("This model has no price, so it cannot be evaluated. Add its price first.");
  const fit = eligibleForStage("build_scene_kit", model);
  if (!fit.ok) throw new EvalRefusal(`${model.label} lacks: ${fit.missing.join(", ")}.`);
  const ceilingMicroUsd = evalCeilingMicroUsd(await evalCap(db), maxUsd);
  return { model, sheets: selectSheets(all, { ...(req.perKind === undefined ? { runs: n } : { perKind: req.perKind }), ...(req.kinds ? { kinds: req.kinds } : {}) }), ceilingMicroUsd };
}

export interface SceneEvalOutcome {
  model: string;
  stopped: Stopped;
  summary: ReturnType<typeof summarize>;
  results: SheetResult[];
}

export async function runSceneEval(db: pg.Pool, req: SceneEvalRequest, deps: SceneEvalDeps): Promise<SceneEvalOutcome> {
  const plan = await planSceneEval(db, req);
  const runId = uuidv7();
  const scopes = await evalScopes(db, runId, plan.ceilingMicroUsd);
  const row = plan.model;
  let tokens = { in: 0, out: 0 };
  const llm = createLlmClient({
    db,
    catalog: { route: async () => row, localServices: () => localServices(db) },
    getKey: deps.getKey,
    buildModel: deps.buildModel,
    budgetScopes: () => scopes,
    makeStep: (model, decls, max) => {
      const step = (deps.makeStep ?? createAiSdkStep)(model, decls, max);
      return async (...a) => {
        const r = await step(...a);
        tokens = { in: r.usage.inputTokens, out: r.usage.outputTokens };
        return r;
      };
    },
  });
  const ports = createPgPaidCallPorts(db);
  const signal = deps.signal ?? new AbortController().signal;
  const stages = new Map<string, { claim: Awaited<ReturnType<typeof openEvalStage>>; ctx: ReturnType<typeof createStageContext>["ctx"] }>();
  const ask: Ask = async (messages, sheet) => {
    let st = stages.get(sheet.id);
    if (!st) {
      const claim = await openEvalStage(db, runId, stages.size);
      const ctx = createStageContext({
        stage: { id: claim.stageRunId, name: "llm_eval", inputHash: "eval", videoId: "00000000-0000-0000-0000-000000000000" },
        claim,
        config: buildEngineConfig(new Map()),
        signal,
        paid: ports,
      }).ctx;
      st = { claim, ctx };
      stages.set(sheet.id, st);
    }
    // Unclear outcome: the error goes up, runSheets stops the run, the reservation stays held (the reconciler ends the stage).
    const out = await llm.agent(st.ctx, { stage: "build_scene_kit", tools: [], messages, maxSteps: 1, maxOutputTokens: MAX_OUTPUT_TOKENS });
    return { text: out.text, inputTokens: tokens.in, outputTokens: tokens.out, costMicroUsd: out.spentMicroUsd };
  };
  const { results, stopped } = await runSheets(plan.sheets, ask, { signal });
  for (const { claim } of stages.values()) await commitStage(db, claim, { evaluated: true }).catch(() => false);
  return { model: row.modelId, stopped, summary: summarize(results, plan.sheets.length, stopped), results };
}
