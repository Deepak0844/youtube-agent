import { createHash } from "node:crypto";
import type { LanguageModel } from "ai";
import type pg from "pg";
import { z } from "zod";
import { DraftInvalidError, runDraft } from "@/server/authoring/draft";
import topicsJson from "@/server/authoring/draft/topics.eval.json";
import type { ModelStep } from "@/server/core/agent-loop";
import { buildEngineConfig } from "@/server/core/engine-config";
import { badgeFor, classifyFailure, decideDraftMode, evalCeilingMicroUsd, FULL_TOPIC_SET, p50, type Badge, type DraftModeName, type EvalRunSummary } from "@/server/core/eval-rules";
import { uuidv7 } from "@/server/core/ids";
import { isLang } from "@/server/core/lang";
import { checkModelUsable, eligibleForStage, microToUsd, priceCardFor, type ModelRow } from "@/server/core/llm-catalog";
import { BudgetRefusedError, KnownFailure, safeReason } from "@/server/core/paid-call";
import { createStageContext } from "@/server/core/stage-handler";
import { recordAudit } from "@/server/db/audit";
import { ensureScopeCopies, periodScopes } from "@/server/db/budget-scopes";
import { getModel, localServices } from "@/server/db/llm-models";
import { createPgPaidCallPorts } from "@/server/db/paid-call-adapter";
import { atomic, commitStage, failStage, markStageNeedsDecision, type Claim } from "@/server/db/stages";
import type { ToolDecl } from "@/server/llm/ai-sdk-step";
import { createLlmClient } from "@/server/llm/client";
import type { WebTools } from "@/server/authoring/draft/shared";

// Per-model Draft eval (Doc 08 section 6, ADR 0006). It spends real money on a hosted model, so it is held to the rules of
// the Test button and of every stage:
//   - owner only: a signed-in session, or the owner's own terminal (`npm run eval:llm`); a token, job or system actor is refused;
//   - needs an explicit model id and `confirmed: true` (the CLI's --yes, after it printed the cost ceiling); an unpriced model is
//     refused before anything is written or reserved;
//   - every model call is a normal paid step (one synthetic `llm_eval` stage per topic, its own claim) through runPaidCall:
//     worst case reserved first, settled with the real cost, never retried when the outcome is unclear;
//   - budgets: a per-run copy of the seeded `eval` cap, lowered to the caller's --max-usd (the lower wins), plus the UTC day
//     and month copies, so the global caps hold here too. When a reservation is refused the run stops and a PARTIAL row is kept;
//   - the stored run holds numbers and a fixed sentence only. Results are append-only (migration 0022).
// The eval changes `llm_models.draft_mode` for the tested model and nothing else: it never touches routes or catalog fields.

export class EvalRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalRefusal";
  }
}

const topicSchema = z.array(z.strictObject({ id: z.string().min(1), topic: z.string().min(1), lang: z.string(), kind: z.enum(["scene_kit", "tsx", "collage", "ai"]) })).length(FULL_TOPIC_SET);
export type EvalTopic = { id: string; topic: string; lang: "en" | "hi" | "ta" | "te" | "ml" | "kn"; kind: "scene_kit" | "tsx" | "collage" | "ai" };

export function fixedTopics(): EvalTopic[] {
  return topicSchema.parse(topicsJson).map((t) => {
    if (!isLang(t.lang)) throw new Error(`topics.eval.json: bad language for ${t.id}`);
    return { ...t, lang: t.lang };
  });
}

export interface EvalDeps {
  getKey(provider: string): Promise<string | null>;
  buildModel(row: ModelRow, getKey: () => Promise<string | null>): LanguageModel;
  /** Fresh web tools for every topic (the set of URLs the search returned must not leak from one topic into the next). */
  makeWeb(): WebTools;
  /** Tests only. */
  makeStep?(model: LanguageModel, decls: ToolDecl[], maxOutputTokens: number): ModelStep;
  /** Tests only: fewer or other topics than the fixed ten. */
  topics?: EvalTopic[];
  /** The owner pressed Ctrl-C (CLI) or cancelled: no new topic starts, a call in flight is abandoned, a partial run is recorded. */
  signal?: AbortSignal;
  /** Tests only: the run's start time (default: now). */
  now?: () => Date;
}

export interface EvalRequest {
  modelId: string;
  mode: DraftModeName;
  /** How many of the fixed topics to run (1..10). Fewer than 10 can never prove agent mode. */
  topics?: number;
  /** USD. The effective ceiling is the lower of this and the seeded `eval` budget. Default 2. */
  maxUsd?: number;
  /** The caller printed the ceiling and the owner said yes. */
  confirmed: boolean;
  /**
   * CALLER-ASSERTED: nothing here proves who the caller is. The CLI passes `owner_cli` (the owner's own terminal). A future web
   * action must call `requireOwner()` first and then pass `session`; it must never forward a kind taken from the request.
   */
  actor: { kind: string };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const STAGE_LEASE_MS = 3_600_000;
const EVAL_STAGE = "llm_eval";

export interface EvalPlan {
  model: ModelRow;
  mode: DraftModeName;
  topics: EvalTopic[];
  ceilingMicroUsd: number;
}

function assertOwner(actor: { kind: string }): void {
  if (actor?.kind !== "session" && actor?.kind !== "owner_cli") throw new EvalRefusal("Only the owner can run a model eval.");
}

export async function evalCap(db: pg.Pool): Promise<number> {
  const r = await db.query<{ cap_micro_usd: string | null }>("select cap_micro_usd from budgets where scope = 'eval'");
  if (!r.rows[0]) throw new EvalRefusal("The eval budget is not set up, so nothing was sent.");
  // no limit on the seeded eval budget leaves only the script's own --max-usd as the ceiling
  return r.rows[0].cap_micro_usd === null ? Number.POSITIVE_INFINITY : Number(r.rows[0].cap_micro_usd);
}

/** Everything that can be checked before any money moves. The CLI prints `ceilingMicroUsd` from here. */
export async function planEval(db: pg.Pool, req: Omit<EvalRequest, "confirmed">, deps: Pick<EvalDeps, "topics">): Promise<EvalPlan> {
  assertOwner(req.actor);
  if (typeof req.modelId !== "string" || !UUID.test(req.modelId)) throw new EvalRefusal("Give the model id of the model to test.");
  if (req.mode !== "agent" && req.mode !== "search_then_write") throw new EvalRefusal("Mode must be agent or search_then_write.");
  const all = deps.topics ?? fixedTopics();
  const n = req.topics ?? all.length;
  if (!Number.isInteger(n) || n < 1 || n > all.length) throw new EvalRefusal(`Topics must be a whole number from 1 to ${all.length}.`);
  const model = await getModel(db, req.modelId);
  if (!model) throw new EvalRefusal("Unknown model.");
  const local = await localServices(db);
  const usable = checkModelUsable(model, local);
  if (!usable.ok) throw new EvalRefusal(`${model.label}: ${usable.reason}`);
  if (!priceCardFor(model, local)) throw new EvalRefusal("This model has no price, so it cannot be evaluated. Add its price first.");
  const fit = eligibleForStage("draft", model);
  if (!fit.ok) throw new EvalRefusal(`${model.label} lacks: ${fit.missing.join(", ")}.`);
  if (req.mode === "agent" && !model.capabilities.toolUse) throw new EvalRefusal(`${model.label} lacks: tool use, so agent mode cannot be tested.`);
  let ceilingMicroUsd: number;
  try {
    ceilingMicroUsd = evalCeilingMicroUsd(await evalCap(db), req.maxUsd ?? 2);
  } catch (e) {
    if (e instanceof RangeError) throw new EvalRefusal(e.message);
    throw e;
  }
  return { model, mode: req.mode, topics: all.slice(0, n), ceilingMicroUsd };
}

export interface EvalOutcome {
  runId: string;
  mode: DraftModeName;
  planned: number;
  topics: number;
  valid: number;
  evidenceValid: number;
  costMicroUsd: number;
  p50LatencyMs: number;
  stopped: "none" | "cap" | "unclear" | "aborted";
  note: string;
  draftMode: DraftModeName;
  draftModeChanged: boolean;
}

/** The synthetic stage one topic is booked under: running, fence 1, its own lease owner. The reconciler ends it if abandoned. */
export async function openEvalStage(db: pg.Pool, runId: string, index: number): Promise<Claim> {
  const id = uuidv7();
  const workerId = `llm-eval:${uuidv7()}`;
  const hash = createHash("sha256").update(`${EVAL_STAGE}:${runId}:${index}:${id}`).digest("hex");
  const { rows } = await db.query<{ lease_until: Date }>(
    `insert into stage_runs (id, video_id, name, status, input_hash, fence, lease_owner, lease_until)
     values ($1, $2, $3, 'running', $4, 1, $5, clock_timestamp() + ($6::bigint * interval '1 millisecond')) returning lease_until`,
    [id, NIL_UUID, EVAL_STAGE, hash, workerId, STAGE_LEASE_MS],
  );
  return { stageRunId: id, fence: 1, workerId, leaseUntil: rows[0]!.lease_until, jobId: "" };
}

/** Budget scopes of one run: its own capped copy of `eval` (lowered to the ceiling), then the UTC day and month copies. */
export async function evalScopes(db: pg.Pool, runId: string, ceilingMicroUsd: number): Promise<string[]> {
  const run = `eval_run:${runId}`;
  const scopes = await ensureScopeCopies(db, [[run, "eval"], ...(await periodScopes(db))]);
  await db.query("update budgets set cap_micro_usd = least(cap_micro_usd, $2::bigint) where scope = $1", [run, ceilingMicroUsd]);
  return scopes;
}

const usdTail = (micro: number) => `${microToUsd(micro)} USD`;

export async function runEval(db: pg.Pool, req: EvalRequest, deps: EvalDeps): Promise<EvalOutcome> {
  const plan = await planEval(db, req, deps);
  if (req.confirmed !== true) {
    throw new EvalRefusal(`This eval can spend up to ${usdTail(plan.ceilingMicroUsd)} on ${plan.model.label}. Confirm it to run.`);
  }
  const runId = uuidv7();
  const startedAt = (deps.now ?? (() => new Date()))();
  const scopes = await evalScopes(db, runId, plan.ceilingMicroUsd);
  const row = plan.model;
  const llm = createLlmClient({
    db,
    catalog: { route: async () => row, localServices: () => localServices(db) },
    getKey: deps.getKey,
    buildModel: deps.buildModel,
    budgetScopes: () => scopes,
    ...(deps.makeStep ? { makeStep: deps.makeStep } : {}),
  });
  const ports = createPgPaidCallPorts(db);
  const signal = deps.signal ?? new AbortController().signal;
  // A stage-ending write that fails is logged (never swallowed): the stage then keeps its short lease and the reconciler ends it.
  const endStage = async (what: string, fn: () => Promise<boolean>): Promise<void> => {
    try {
      if (!(await fn())) console.error(JSON.stringify({ event: "llm_eval.stage_end_rejected", what }));
    } catch (e) {
      console.error(JSON.stringify({ event: "llm_eval.stage_end_failed", what, name: e instanceof Error ? e.name : "unknown" }));
    }
  };

  let valid = 0;
  let evidenceValid = 0;
  let done = 0;
  const stageIds: string[] = [];
  const latencies: number[] = [];
  let stopped: EvalOutcome["stopped"] = "none";
  let note = "";

  for (const [index, t] of plan.topics.entries()) {
    if (signal.aborted) {
      stopped = "aborted";
      note = `Stopped by the owner after ${done} of ${plan.topics.length} topics. Nothing more was sent.`;
      break;
    }
    const claim = await openEvalStage(db, runId, index);
    stageIds.push(claim.stageRunId);
    const ctx = createStageContext({
      stage: { id: claim.stageRunId, name: EVAL_STAGE, inputHash: "eval", videoId: NIL_UUID },
      claim,
      config: buildEngineConfig(new Map()),
      signal,
      paid: ports,
    }).ctx;
    const started = performance.now();
    try {
      const out = await runDraft(ctx, { llm, web: deps.makeWeb(), db, mode: plan.mode }, { topic: t.topic, lang: t.lang, kind: t.kind });
      latencies.push(Math.round(performance.now() - started));
      valid++;
      // Evidence counts only with at least one sourced claim: a script of computed claims alone proves nothing about the web tools.
      if (out.script.evidence.some((c) => c.kind === "sourced")) evidenceValid++;
      done++;
      await endStage("commit", () => commitStage(db, claim, { evaluated: true }));
    } catch (err) {
      if (err instanceof BudgetRefusedError) {
        await endStage("budget_refused", () => failStage(db, claim, "budget_refused"));
        stopped = "cap";
        note = `Stopped at the spend cap after ${done} of ${plan.topics.length} topics. Nothing more was sent.`;
        break;
      }
      if (err instanceof DraftInvalidError) {
        latencies.push(Math.round(performance.now() - started));
        if (classifyFailure(err.problems).scriptValid) valid++;
        done++;
        await endStage("draft_invalid", () => failStage(db, claim, "draft_invalid"));
        continue;
      }
      if (err instanceof KnownFailure) {
        // Refused or failed with the reservation released ("nothing was charged"): this topic counts as not valid.
        done++;
        await endStage("known_failure", () => failStage(db, claim, safeReason(err)));
        continue;
      }
      // Unclear outcome: a paid call may have been charged. Never retried; the reservation stays held; the eval stops here.
      await endStage("needs_decision", () => markStageNeedsDecision(db, claim, "llm eval: unclear outcome"));
      console.error(JSON.stringify({ event: "llm_eval.unclear_outcome", name: err instanceof Error ? err.name : "unknown" }));
      if (signal.aborted) {
        stopped = "aborted";
        note = `Stopped by the owner after ${done} of ${plan.topics.length} topics. A call was in flight, so it may have been charged; its reserved amount stays held until it is looked at.`;
        break;
      }
      stopped = "unclear";
      note = `Stopped after ${done} of ${plan.topics.length} topics: a call did not finish, so it may have been charged. Its reserved amount stays held until it is looked at.`;
      break;
    }
  }

  // Cost is what the ledger settled for this run's stages (not what a draft reported): an unclear call keeps its reservation but is not "spent".
  const cost = Number(
    (await db.query<{ s: string }>("select coalesce(sum(actual_micro_usd), 0)::bigint as s from spend_intents where status = 'done' and stage_run_id = any($1::uuid[])", [stageIds])).rows[0]!.s,
  );
  const finished = new Date();
  const p50Latency = p50(latencies);
  const result = await atomic(db, async (q) => {
    const c = q as pg.PoolClient;
    await c.query(
      `insert into llm_eval_runs (id, model_id, started_at, finished_at, topics, valid, evidence_valid, cost_micro_usd, p50_latency_ms, mode_tested, note)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [runId, row.id, startedAt, finished, done, valid, evidenceValid, cost, p50Latency, plan.mode, note],
    );
    return applyDraftMode(c, row.id, "owner");
  });
  return { runId, mode: plan.mode, planned: plan.topics.length, topics: done, valid, evidenceValid, costMicroUsd: cost, p50LatencyMs: p50Latency, stopped, note, draftMode: result.mode, draftModeChanged: result.changed };
}

interface RunRow {
  mode_tested: string;
  started_at: Date;
  topics: number;
  valid: number;
  evidence_valid: number;
  cost_micro_usd: string;
}
const toSummary = (r: RunRow): EvalRunSummary => ({
  modeTested: r.mode_tested === "agent" ? "agent" : "search_then_write",
  startedAt: r.started_at,
  topics: r.topics,
  valid: r.valid,
  evidenceValid: r.evidence_valid,
  costMicroUsd: Number(r.cost_micro_usd),
});

export async function listEvalRuns(db: pg.Pool | pg.PoolClient, modelId: string): Promise<EvalRunSummary[]> {
  if (!UUID.test(modelId)) return [];
  const { rows } = await db.query<RunRow>(
    "select mode_tested, started_at, topics, valid, evidence_valid, cost_micro_usd from llm_eval_runs where model_id = $1 order by started_at, id",
    [modelId],
  );
  return rows.map(toSummary);
}

/** model id -> badge, for the models page. A model with no run has no entry. */
export async function getEvalBadges(db: pg.Pool): Promise<Map<string, Badge>> {
  const { rows } = await db.query<RunRow & { model_id: string }>(
    "select model_id, mode_tested, started_at, topics, valid, evidence_valid, cost_micro_usd from llm_eval_runs order by started_at, id",
  );
  const by = new Map<string, EvalRunSummary[]>();
  for (const r of rows) by.set(r.model_id, [...(by.get(r.model_id) ?? []), toSummary(r)]);
  const out = new Map<string, Badge>();
  for (const [id, runs] of by) {
    const b = badgeFor(runs);
    if (b) out.set(id, b);
  }
  return out;
}

/**
 * Sets `llm_models.draft_mode` from the model's runs (decideDraftMode) and audits a real change as `model.changed`.
 * The only writer of draft_mode besides the owner's SQL. Runs inside the caller's transaction.
 */
export async function applyDraftMode(c: pg.PoolClient, modelId: string, by: string): Promise<{ mode: DraftModeName; changed: boolean }> {
  // Lock the model row BEFORE reading its runs: two evals finishing together on one model take turns, and the second one
  // decides from a list that already contains the first one's run, so a stale mode can never be written last.
  const cur = await c.query<{ draft_mode: string; provider: string; model_id: string }>("select draft_mode, provider, model_id from llm_models where id = $1 for update", [modelId]);
  const mode = decideDraftMode(await listEvalRuns(c, modelId));
  if (!cur.rows[0]) return { mode, changed: false };
  if (cur.rows[0].draft_mode === mode) return { mode, changed: false };
  await c.query("update llm_models set draft_mode = $2, updated_at = now() where id = $1", [modelId, mode]);
  await recordAudit(c, "model.changed", { id: modelId, provider: cur.rows[0].provider, model: cur.rows[0].model_id, draftMode: mode, from: cur.rows[0].draft_mode, by, source: "eval" });
  return { mode, changed: true };
}
