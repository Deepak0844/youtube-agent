import type { LanguageModel } from "ai";
import { createHash } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { estimateInputTokens, type Message, type ModelStep } from "@/server/core/agent-loop";
import { microToUsd, priceCardFor, type ModelRow } from "@/server/core/llm-catalog";
import { uuidv7 } from "@/server/core/ids";
import { BudgetRefusedError, KnownFailure, runPaidCall, safeReason, type ClaimLike, type PaidCallPorts } from "@/server/core/paid-call";
import { worstCaseMicroUsd } from "@/server/core/spend";
import { recordAudit } from "@/server/db/audit";
import { CatalogError, getModel, localServices } from "@/server/db/llm-models";
import { createPgPaidCallPorts } from "@/server/db/paid-call-adapter";
import { atomic, commitStage, failStage, markStageNeedsDecision, type Claim } from "@/server/db/stages";
import { createAiSdkStep, type ToolDecl } from "@/server/llm/ai-sdk-step";
import { parseAnswer } from "@/server/llm/client";

// The Test button on /settings/models: one tiny real call to the chosen model. It is the first button that can spend money,
// so it is held to the same rules as a stage:
//   - session only (the caller is the page's server action, after requireOwner);
//   - an unpriced model is refused before anything is written, reserved or sent;
//   - the call is a normal paid step (synthetic stage_runs row "model_test", its own claim, its own call key) through
//     runPaidCall: worst case reserved first, settled with the real token cost, released on a clear provider refusal, parked
//     (reservation kept) when the outcome is unclear; it is never retried;
//   - budget: one row per UTC day, "llm_test:YYYY-MM-DD", copied from the seeded "llm_test" cap (0.50 USD) on first use;
//   - 30 s cooldown per model, claimed atomically in the database before anything else (20 clicks = 1 call);
//   - the result holds numbers and fixed sentences only: never the model's answer, a provider body or the key.
// A free local model takes exactly the same path with price 0 (reserve 0, audit written).

export interface TestResult {
  ok: boolean;
  latencyMs: number;
  structuredOutput: boolean;
  costMicroUsd: number;
  message: string;
}

export interface TestDeps {
  /** The vault read for one provider; called by the model factory inside the request. */
  getKey(provider: string): Promise<string | null>;
  buildModel(row: ModelRow, getKey: () => Promise<string | null>): LanguageModel;
  /** Tests only. */
  makeStep?(model: LanguageModel, decls: ToolDecl[], maxOutputTokens: number): ModelStep;
  cooldownMs?: number;
  timeoutMs?: number;
  /** Tests only: wraps the spend ports (e.g. to make the release fail). */
  wrapPorts?(ports: PaidCallPorts): PaidCallPorts;
}

export const TEST_MAX_OUTPUT_TOKENS = 64;
const DEFAULT_COOLDOWN_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 25_000; // under the cooldown, so a second click cannot overlap a still-running first call
const STAGE_LEASE_MS = 300_000;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PROMPT: Message[] = [
  { role: "system", content: "Reply with JSON only. No other text." },
  { role: "user", content: 'Reply with exactly {"ok":true}' },
];
const answerSchema = z.strictObject({ ok: z.literal(true) });

function usdTail(micro: number): string {
  return `${microToUsd(micro)} USD`;
}

async function dayScope(db: pg.Pool): Promise<string> {
  // The name comes from the database clock (UTC day), so the app's clock and time zone never decide the cap window.
  const { rows } = await db.query<{ scope: string }>("select 'llm_test:' || to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD') as scope");
  const scope = rows[0]!.scope;
  await db.query(
    `insert into budgets (scope, cap_micro_usd) select $1, cap_micro_usd from budgets where scope = 'llm_test'
     on conflict (scope) do nothing`,
    [scope],
  );
  const have = await db.query("select 1 from budgets where scope = $1", [scope]);
  if (have.rowCount === 0) throw new CatalogError("The test budget is not set up, so nothing was sent.");
  return scope;
}

/** Claims the per-model cooldown slot. The placeholder is overwritten when the test ends; if the process dies it stays and says so. */
async function claimCooldown(db: pg.Pool, id: string, cooldownMs: number): Promise<void> {
  const placeholder = { ok: false, latencyMs: 0, structuredOutput: false, costMicroUsd: 0, message: "A test was started but never reported back." };
  const r = await db.query(
    `update llm_models
        set last_test = $2::jsonb || jsonb_build_object('at', to_jsonb(clock_timestamp()))
      where id = $1
        and (last_test is null
             or case when jsonb_typeof(last_test->'at') = 'string'
                          and last_test->>'at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9:.]+(Z|[+-][0-9:]+)?$'
                     then (last_test->>'at')::timestamptz <= clock_timestamp() - ($3::double precision * interval '1 millisecond')
                     else true end)`,
    [id, JSON.stringify(placeholder), cooldownMs],
  );
  if (r.rowCount !== 1) throw new CatalogError("This model was tested a moment ago. Try again shortly.");
}

/** The synthetic stage the call is booked under: running, fence 1, its own lease owner. Nothing else ever claims it. */
export async function openTestStage(db: pg.Pool): Promise<Claim> {
  const id = uuidv7();
  const workerId = `model-test:${uuidv7()}`;
  const hash = createHash("sha256").update(`model_test:${id}`).digest("hex");
  const { rows } = await db.query<{ lease_until: Date }>(
    `insert into stage_runs (id, video_id, name, status, input_hash, fence, lease_owner, lease_until)
     values ($1, $2, 'model_test', 'running', $3, 1, $4, clock_timestamp() + ($5::bigint * interval '1 millisecond'))
     returning lease_until`,
    [id, NIL_UUID, hash, workerId, STAGE_LEASE_MS],
  );
  return { stageRunId: id, fence: 1, workerId, leaseUntil: rows[0]!.lease_until, jobId: "" };
}

export async function testModel(db: pg.Pool, modelId: string, actor: { kind: string }, deps: TestDeps): Promise<TestResult> {
  if (actor?.kind !== "session") throw new CatalogError("Only a signed-in session can test a model.");
  if (typeof modelId !== "string" || !UUID.test(modelId)) throw new CatalogError("Unknown model.");
  const row = await getModel(db, modelId);
  if (!row) throw new CatalogError("Unknown model.");
  const local = await localServices(db);
  const price = priceCardFor(row, local);
  if (!price) throw new CatalogError("This model has no price, so it cannot be tested. Add its price first.");

  let model: LanguageModel;
  try {
    model = deps.buildModel(row, () => deps.getKey(row.provider));
  } catch (err) {
    throw new CatalogError(err instanceof Error ? safeReason(err) : "The model could not be set up.");
  }
  const reserveMicroUsd = worstCaseMicroUsd(price, { inputTokens: estimateInputTokens(PROMPT), maxOutputTokens: TEST_MAX_OUTPUT_TOKENS });

  // The day row is chosen ONCE here and that exact scope string is what gets reserved and settled. A click that starts just
  // before midnight UTC is booked, start to finish, on the day it started; it can never reserve on one row and settle on another.
  const scope = await dayScope(db);
  await claimCooldown(db, modelId, deps.cooldownMs ?? DEFAULT_COOLDOWN_MS);
  const claim = await openTestStage(db);
  const basePorts = createPgPaidCallPorts(db);
  const ports = deps.wrapPorts ? deps.wrapPorts(basePorts) : basePorts;
  const step = (deps.makeStep ?? createAiSdkStep)(model, [], TEST_MAX_OUTPUT_TOKENS);

  // Every path below ends the synthetic stage in a terminal state. If that write itself fails (database blip) the row is left
  // running with a short lease, and the reconciler fails it instead of requeueing (it never requeues "model_test" rows).
  const end = async (fn: () => Promise<boolean>): Promise<void> => {
    for (let i = 0; i < 2; i++) {
      try {
        if (await fn()) return;
      } catch {
        // retry once, then leave it to the reconciler
      }
    }
  };
  const unclear = async (): Promise<TestResult> => {
    await end(() => markStageNeedsDecision(db, claim, "model test: unclear outcome"));
    return { ok: false, latencyMs: 0, structuredOutput: false, costMicroUsd: 0, message: `The test did not finish. The provider may have charged up to ${usdTail(reserveMicroUsd)} for it; that amount stays reserved until it is looked at.` };
  };

  let result: TestResult;
  try {
    const out = await runPaidCall(
      ports,
      { claim: claim as ClaimLike, stepIndex: 0, toolCallIndex: 0, reserveMicroUsd, budgetScopes: [scope], kind: "paid" },
      async (key) => {
        const started = performance.now();
        const r = await step(PROMPT, key, AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS));
        const latencyMs = Math.round(performance.now() - started);
        const actualMicroUsd = worstCaseMicroUsd(price, { inputTokens: r.usage.inputTokens, maxOutputTokens: r.usage.outputTokens });
        // Only what the page may show is kept as the stored result: no answer text.
        return { result: { latencyMs, structured: parseAnswer(r.text, answerSchema).ok, actualMicroUsd }, actualMicroUsd };
      },
    );
    await end(() => commitStage(db, claim, { tested: true }));
    result = {
      ok: true,
      latencyMs: out.latencyMs,
      structuredOutput: out.structured,
      costMicroUsd: out.actualMicroUsd,
      message: `Answered in ${out.latencyMs} ms. ${out.structured ? "Structured JSON worked." : "It did not return the JSON asked for, so do not rely on it for structured output."} Cost ${usdTail(out.actualMicroUsd)}.`,
    };
  } catch (err) {
    const base = { ok: false, latencyMs: 0, structuredOutput: false, costMicroUsd: 0 };
    if (err instanceof BudgetRefusedError) {
      await end(() => failStage(db, claim, "budget_refused"));
      result = { ...base, message: "Today's Test budget is used up. Nothing was sent. Try again tomorrow." };
    } else if (err instanceof KnownFailure) {
      // "Nothing was charged" is said only when the release is CONFIRMED in the database (the intent is failed_known).
      // If releasing the reservation failed, the money is still held and the outcome is reported as unclear.
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
        result = { ...base, message: `${why}${/[.!?]$/.test(why) ? "" : "."} Nothing was charged.` };
      } else {
        console.error(JSON.stringify({ event: "model_test.release_unconfirmed" }));
        result = await unclear();
      }
    } else {
      // Unclear: the call may have been charged. Never retried. The reservation stays held and the stage is parked.
      console.error(JSON.stringify({ event: "model_test.unclear_outcome", name: err instanceof Error ? err.name : "unknown" }));
      result = await unclear();
    }
  }

  await atomic(db, async (q) => {
    await q.query("update llm_models set last_test = $2::jsonb || jsonb_build_object('at', to_jsonb(clock_timestamp())) where id = $1", [modelId, JSON.stringify(result)]);
    await recordAudit(q as pg.PoolClient, "model.tested", {
      id: modelId,
      provider: row.provider,
      model: row.modelId,
      free: row.isFree,
      ok: result.ok,
      structured: result.structuredOutput,
      latencyMs: result.latencyMs,
      costMicroUsd: result.costMicroUsd,
    });
  });
  return result;
}

export interface LastTest extends TestResult {
  at: Date;
}

const storedTest = z.object({
  at: z.string().transform((s, ctx) => {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) ctx.addIssue({ code: "custom", message: "bad date" });
    return d;
  }),
  ok: z.boolean(),
  latencyMs: z.number().int().min(0),
  structuredOutput: z.boolean(),
  costMicroUsd: z.number().int().min(0),
  message: z.string().max(500),
});

/** model id -> last Test result. A row that does not parse (hand-edited) reads as "never tested". */
export async function getLastTests(db: pg.Pool): Promise<Map<string, LastTest>> {
  const { rows } = await db.query<{ id: string; last_test: unknown }>("select id, last_test from llm_models where last_test is not null");
  const out = new Map<string, LastTest>();
  for (const r of rows) {
    const p = storedTest.safeParse(r.last_test);
    if (p.success) out.set(r.id, p.data);
  }
  return out;
}
