import type { LanguageModel } from "ai";
import type pg from "pg";
import { estimateInputTokens, type Message, type ModelStep } from "@/server/core/agent-loop";
import { microToUsd, priceCardFor } from "@/server/core/llm-catalog";
import { BudgetRefusedError, KnownFailure, runPaidCall, safeReason, type ClaimLike, type PaidCallPorts } from "@/server/core/paid-call";
import { worstCaseMicroUsd } from "@/server/core/spend";
import { PROBE_QUESTION, clipAnswer, makeProbePng, visionOk } from "@/server/core/vision-probe";
import { recordAudit } from "@/server/db/audit";
import { CatalogError, getModel, localServices } from "@/server/db/llm-models";
import { claimCooldown, openTestStage, type TestDeps, type TestResult } from "@/server/db/llm-test";
import { createPgPaidCallPorts } from "@/server/db/paid-call-adapter";
import { atomic, commitStage, failStage, markStageNeedsDecision } from "@/server/db/stages";
import { createVisionStep } from "@/server/llm/ai-sdk-step";
import { sharedPacer, type Pacer } from "@/server/llm/pacer";

// "Test image reading" on /settings/models: ONE tiny built-in picture + one question, under the same rules as Test
// (session only, priced model, reserve-first on the daily llm_test budget, per-model cooldown claimed in the database,
// paced by llm.call_gap_ms, never retried when unclear). A clear pass sets capabilities.vision = true; a clear 400/422
// refusal sets it false; a wrong-looking answer or anything unclear leaves it alone. Claude Code is text-only: refused.

export interface VisionDeps extends Omit<TestDeps, "makeStep"> {
  /** Tests only. */
  makeStep?(model: LanguageModel, maxOutputTokens: number, png: Uint8Array, question: string): ModelStep;
  callGapMs?(): Promise<number>;
  pacer?: Pacer;
}

export const VISION_MAX_OUTPUT_TOKENS = 40;
const IMAGE_TOKEN_ALLOWANCE = 1500; // generous per-image input estimate, so the reserve is a ceiling, not a guess
const COOLDOWN_MS = 30_000;
const TIMEOUT_MS = 25_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROMPT: Message[] = [{ role: "user", content: PROBE_QUESTION }];

export async function testVision(db: pg.Pool, modelId: string, actor: { kind: string }, deps: VisionDeps): Promise<TestResult> {
  if (actor?.kind !== "session") throw new CatalogError("Only a signed-in session can test a model.");
  if (typeof modelId !== "string" || !UUID.test(modelId)) throw new CatalogError("Unknown model.");
  const row = await getModel(db, modelId);
  if (!row) throw new CatalogError("Unknown model.");
  if (row.provider === "claude_code") throw new CatalogError("Claude Code reads text only here, so there is no image test.");
  const price = priceCardFor(row, await localServices(db));
  if (!price) throw new CatalogError("This model has no price, so it cannot be tested. Add its price first.");

  let model: LanguageModel;
  try {
    model = deps.buildModel(row, () => deps.getKey(row.provider));
  } catch (err) {
    throw new CatalogError(err instanceof Error ? safeReason(err) : "The model could not be set up.");
  }
  const reserveMicroUsd = worstCaseMicroUsd(price, { inputTokens: estimateInputTokens(PROMPT) + IMAGE_TOKEN_ALLOWANCE, maxOutputTokens: VISION_MAX_OUTPUT_TOKENS });

  const timeout = AbortSignal.timeout(deps.timeoutMs ?? TIMEOUT_MS);
  // Pace hosted models (free-tier limits) BEFORE anything is reserved, as the normal client does.
  if (deps.callGapMs && row.endpointKind !== "local") await (deps.pacer ?? sharedPacer).wait(`${row.provider}:${row.modelId}`, await deps.callGapMs(), timeout);

  const { rows: sc } = await db.query<{ scope: string }>("select 'llm_test:' || to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD') as scope");
  const scope = sc[0]!.scope;
  await db.query("insert into budgets (scope, cap_micro_usd) select $1, cap_micro_usd from budgets where scope = 'llm_test' on conflict (scope) do nothing", [scope]);
  if ((await db.query("select 1 from budgets where scope = $1", [scope])).rowCount === 0) throw new CatalogError("The test budget is not set up, so nothing was sent.");
  await claimCooldown(db, modelId, deps.cooldownMs ?? COOLDOWN_MS);
  const claim = await openTestStage(db);
  const base = createPgPaidCallPorts(db);
  const ports: PaidCallPorts = deps.wrapPorts ? deps.wrapPorts(base) : base;
  const step = (deps.makeStep ?? createVisionStep)(model, VISION_MAX_OUTPUT_TOKENS, makeProbePng(), PROBE_QUESTION);

  const end = async (fn: () => Promise<boolean>): Promise<void> => {
    for (let i = 0; i < 2; i++) {
      try {
        if (await fn()) return;
      } catch {
        // retry once, then leave it to the reconciler
      }
    }
  };
  const no = (message: string): TestResult => ({ ok: false, latencyMs: 0, structuredOutput: false, costMicroUsd: 0, message });
  const unclear = async (): Promise<TestResult> => {
    await end(() => markStageNeedsDecision(db, claim, "vision test: unclear outcome"));
    return no(`The test did not finish. The provider may have charged up to ${microToUsd(reserveMicroUsd)} USD for it; that amount stays reserved until it is looked at.`);
  };
  let result: TestResult;
  let visionFlag: boolean | null = null; // null = leave the flag alone
  try {
    const out = await runPaidCall(
      ports,
      { claim: claim as ClaimLike, stepIndex: 0, toolCallIndex: 0, reserveMicroUsd, budgetScopes: [scope], kind: "paid" },
      async (key) => {
        const started = performance.now();
        const r = await step(PROMPT, key, timeout);
        const actualMicroUsd = worstCaseMicroUsd(price, { inputTokens: r.usage.inputTokens, maxOutputTokens: r.usage.outputTokens });
        return { result: { latencyMs: Math.round(performance.now() - started), answer: clipAnswer(r.text), ok: visionOk(r.text), actualMicroUsd }, actualMicroUsd };
      },
    );
    await end(() => commitStage(db, claim, { tested: true }));
    const cost = `Cost ${microToUsd(out.actualMicroUsd)} USD.`;
    if (out.ok) {
      visionFlag = true;
      result = { ok: true, latencyMs: out.latencyMs, structuredOutput: false, costMicroUsd: out.actualMicroUsd, message: `Image reading works: it said "${out.answer}". ${cost}` };
    } else {
      result = { ok: false, latencyMs: out.latencyMs, structuredOutput: false, costMicroUsd: out.actualMicroUsd, message: `This model could not read the image: it answered but looked wrong ("${out.answer}"). ${cost}` };
    }
  } catch (err) {
    if (err instanceof BudgetRefusedError) {
      await end(() => failStage(db, claim, "budget_refused"));
      result = no("Today's Test budget is used up. Nothing was sent. Try again tomorrow.");
    } else if (err instanceof KnownFailure) {
      // "Nothing was charged" only when the release is CONFIRMED in the database; otherwise it is reported as unclear.
      let released = false;
      try {
        const { rows } = await db.query<{ status: string }>("select status from spend_intents where stage_run_id = $1", [claim.stageRunId]);
        released = rows.length === 1 && rows[0]!.status === "failed_known";
      } catch {
        released = false;
      }
      if (released) {
        const why = safeReason(err);
        await end(() => failStage(db, claim, why));
        if (/\((400|422)\)/.test(why)) visionFlag = false; // the provider refused the request itself: it does not take images
        result = no(`This model could not read the image: ${why}${/[.!?]$/.test(why) ? "" : "."} Nothing was charged.`);
      } else {
        result = await unclear();
      }
    } else {
      console.error(JSON.stringify({ event: "vision_test.unclear_outcome", name: err instanceof Error ? err.name : "unknown" }));
      result = await unclear();
    }
  }

  await atomic(db, async (q) => {
    await q.query("update llm_models set last_test = $2::jsonb || jsonb_build_object('at', to_jsonb(clock_timestamp())) where id = $1", [modelId, JSON.stringify(result)]);
    if (visionFlag !== null) await q.query("update llm_models set capabilities = jsonb_set(capabilities, '{vision}', to_jsonb($2::boolean)) where id = $1", [modelId, visionFlag]);
    await recordAudit(q as pg.PoolClient, "model.vision_tested", {
      id: modelId,
      provider: row.provider,
      model: row.modelId,
      free: row.isFree,
      ok: result.ok,
      vision: visionFlag,
      costMicroUsd: result.costMicroUsd,
    });
  });
  return result;
}
