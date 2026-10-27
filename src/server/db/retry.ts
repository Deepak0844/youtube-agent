import type pg from "pg";
import type { BreakerEvent } from "@/server/core/breaker";
import { uuidv7 } from "@/server/core/ids";
import { STAGE_NAMES, type StageName } from "@/server/core/pipeline-plan";
import { retryDecision } from "@/server/core/retry-policy";
import type { StageOutcome } from "@/server/core/stage-runner";
import { admitStage, recordBreakerEvent } from "./breakers";
import { getEngineConfig } from "./engine-config";
import { inTx, NO_DECISIONS, wantedHashLocked, type EnqueueOnly, type PipelineReaders } from "./pipeline";
import type { ReconcileResult } from "./reconciler";
import { getStage } from "./stages";

// Bounded retry of CONFIRMED provider rejections, and the breaker bookkeeping for stage outcomes.
//
// Owner rule: an unclear outcome is NEVER retried. A retry happens only when ALL of these hold for the failed row:
//   1. it ended `failed` with class "transient" in its result (the provider layer saw the refusal before any work was
//      done: see NotProcessedError in core/error-class.ts; nothing else carries the mark),
//   2. EVERY paid call it made ended failed_known (released, not charged). A row with any pending, unknown or done
//      intent is refused: pending/unknown may have been charged, and a done step would be paid for again by a fresh row,
//   3. it is the newest run of that stage, its input is still the current input, the video is live and not cancelled,
//   4. the tries so far are under engine.retry_attempts,
//   5. the breaker for that stage lets one stage through.
// The retry is a NEW stage_runs row (retry_of = the failed row, same input hash). Call keys are derived from the stage run
// id, so the new row can never reuse a key of the failed one. The failed row stays failed. The wait is a database-clock
// not_before on the row: Redis only carries a delayed job, so a Redis wipe or a Mac sleep loses nothing.

export type ScheduleResult =
  | { kind: "scheduled"; stageRunId: string; notBefore: Date; delayMs: number; enqueued: boolean }
  | { kind: "exhausted"; plain: string }
  | { kind: "held"; stage: StageName; until: Date | null }
  | { kind: "not_retryable"; reason: string };

type Decided = { kind: "scheduled"; stageRunId: string; inputHash: string; notBefore: Date; delayMs: number } | Exclude<ScheduleResult, { kind: "scheduled" }>;

const stop = (reason: string): Decided => ({ kind: "not_retryable", reason });

export async function scheduleRetry(db: pg.Pool, queue: EnqueueOnly, failedStageId: string, readers: PipelineReaders = NO_DECISIONS): Promise<ScheduleResult> {
  const cfg = await getEngineConfig(db);
  const decided = await inTx(db, async (c): Promise<Decided> => {
    const pre = await c.query<{ video_id: string; name: string; status: string; class: string | null }>("select video_id, name, status, result->>'class' as class from stage_runs where id = $1", [failedStageId]);
    const head = pre.rows[0];
    if (!head) return stop("missing");
    // Cheap early exit before any lock; both are checked again under the row lock below.
    if (head.status !== "failed") return stop("not_failed");
    if (head.class !== "transient") return stop("not_transient");
    if (!(STAGE_NAMES as readonly string[]).includes(head.name)) return stop("not_a_pipeline_stage");
    const stage = head.name as StageName;
    // Lock order: video row (inside wantedHashLocked), then the stage row. Same as advance and cancel.
    const want = await wantedHashLocked(c, head.video_id, stage, readers);
    const { rows } = await c.query<{ status: string; input_hash: string; result: { class?: string; error?: string } | null; cancel_requested: boolean }>(
      "select status, input_hash, result, cancel_requested from stage_runs where id = $1 for update",
      [failedStageId],
    );
    const row = rows[0]!;
    if (row.status !== "failed") return stop("not_failed");
    if (row.result?.class !== "transient") return stop("not_transient");
    if (row.cancel_requested) return stop("cancel_requested");
    if (want === null) return stop("video_not_live");
    const child = await c.query("select 1 from stage_runs where retry_of = $1", [failedStageId]);
    if (child.rowCount! > 0) return stop("already_scheduled");
    const newest = await c.query<{ id: string }>("select id from stage_runs where video_id = $1 and name = $2 order by created_at desc, id desc limit 1", [head.video_id, stage]);
    if (newest.rows[0]!.id !== failedStageId) return stop("superseded");
    const open = await c.query("select 1 from spend_intents where stage_run_id = $1 and status <> 'failed_known'", [failedStageId]);
    if (open.rowCount! > 0) return stop("paid_call_not_cleared");
    if (want !== row.input_hash) return stop("stale_input");
    const chain = await c.query<{ n: number }>(
      `with recursive chain as (
         select id, retry_of from stage_runs where id = $1
         union all
         select s.id, s.retry_of from stage_runs s join chain c on s.id = c.retry_of
       ) select count(*)::int as n from chain`,
      [failedStageId],
    );
    const tries = chain.rows[0]!.n;
    const d = retryDecision({ errorClass: "transient", attemptsSoFar: tries, maxAttempts: cfg.retryAttempts, schedule: cfg.retryBackoffSeconds });
    if (d.kind === "stop") {
      if (d.reason !== "exhausted") return stop(d.reason);
      const plain = `Stopped after ${tries} ${tries === 1 ? "try" : "tries"}. Every try was refused by the provider before any work was done, so nothing was charged. Last error: ${row.result?.error ?? "unknown"}`;
      await c.query("update stage_runs set result = result || $2::jsonb, updated_at = clock_timestamp() where id = $1 and status = 'failed'", [failedStageId, JSON.stringify({ exhausted: true, plain })]);
      return { kind: "exhausted", plain };
    }
    const gate = await admitStage(c, stage);
    if (!gate.allowed) return { kind: "held", stage, until: gate.until };
    const id = uuidv7();
    const ins = await c.query<{ not_before: Date }>(
      `insert into stage_runs (id, video_id, name, status, input_hash, retry_of, not_before)
       values ($1, $2, $3, 'queued', $4, $5, clock_timestamp() + ($6::bigint * interval '1 millisecond'))
       returning not_before`,
      [id, head.video_id, stage, row.input_hash, failedStageId, d.delayMs],
    );
    return { kind: "scheduled", stageRunId: id, inputHash: row.input_hash, notBefore: ins.rows[0]!.not_before, delayMs: d.delayMs };
  });
  if (decided.kind !== "scheduled") return decided;
  // After the commit. If Redis is down the row stays queued with its not_before and the reconciler enqueues it once due.
  let enqueued = true;
  try {
    await queue.enqueue(decided.stageRunId, 0, 0, decided.inputHash, { delayMs: decided.delayMs });
  } catch {
    enqueued = false;
  }
  return { kind: "scheduled", stageRunId: decided.stageRunId, notBefore: decided.notBefore, delayMs: decided.delayMs, enqueued };
}

export interface SweepRetriesResult {
  scheduled: string[];
  held: string[];
}

/**
 * Repairs the gap between "stage failed" and "retry row created" (a worker that died in between) and retries that were
 * held by an open breaker. Only the newest failed run of each stage with a transient mark and no retry yet is looked at.
 */
export async function sweepRetries(db: pg.Pool, queue: EnqueueOnly, readers: PipelineReaders = NO_DECISIONS, opts: { limit?: number } = {}): Promise<SweepRetriesResult> {
  const { rows } = await db.query<{ id: string }>(
    `select s.id from stage_runs s
      where s.status = 'failed' and s.result->>'class' = 'transient' and coalesce(s.result->>'exhausted', '') <> 'true'
        and not exists (select 1 from stage_runs c where c.retry_of = s.id)
        and not exists (select 1 from stage_runs n where n.video_id = s.video_id and n.name = s.name and (n.created_at, n.id) > (s.created_at, s.id))
        and exists (select 1 from videos v where v.id = s.video_id and v.status in ('active', 'waiting'))
      order by s.created_at, s.id limit $1`,
    [opts.limit ?? 200],
  );
  const out: SweepRetriesResult = { scheduled: [], held: [] };
  for (const { id } of rows) {
    try {
      const r = await scheduleRetry(db, queue, id, readers);
      if (r.kind === "scheduled") out.scheduled.push(r.stageRunId);
      if (r.kind === "held") out.held.push(id);
    } catch {
      // one bad row must not stop the sweep; the next tick looks again
    }
  }
  return out;
}

// What each terminal outcome tells the breaker. A budget refusal is the owner's cap, not a provider problem; a cancel,
// a lost lease and a no-op say nothing about the provider either. A parked or timed-out call is trouble worth counting.
const BREAKER_EVENT: Partial<Record<StageOutcome["kind"], BreakerEvent>> = {
  committed: "success",
  known_failure: "failure",
  known_failure_release_failed: "failure",
  timed_out: "failure",
  needs_decision: "failure",
};

export interface OutcomeFollowUp {
  /** set when this outcome just opened (or reopened) a breaker: the owner is told */
  breakerOpened?: { stage: string; openedAtMs: number };
  retry?: ScheduleResult;
}

/**
 * Called once per finished stage attempt. Records the breaker event, then (for a clear provider rejection only) schedules
 * the retry. Safe to call twice: the breaker would count twice, so the runtime calls it only for a fresh outcome, and the
 * retry row is guarded by a unique index.
 */
export async function afterStageOutcome(db: pg.Pool, queue: EnqueueOnly, o: { kind: StageOutcome["kind"]; stageRunId: string }, readers: PipelineReaders = NO_DECISIONS): Promise<OutcomeFollowUp> {
  const stage = await getStage(db, o.stageRunId);
  if (!stage) return {};
  const out: OutcomeFollowUp = {};
  const event = BREAKER_EVENT[o.kind];
  if (event) {
    const state = await recordBreakerEvent(db, stage.name, event);
    if (state.justOpened && state.openedAtMs !== null) out.breakerOpened = { stage: stage.name, openedAtMs: state.openedAtMs };
  }
  if (o.kind === "known_failure") out.retry = await scheduleRetry(db, queue, o.stageRunId, readers);
  return out;
}

/** Stages the reconciler failed (too many attempts) or parked (unknown paid outcome) count against their breaker too. */
export async function afterReconcile(db: pg.Pool, r: Partial<Pick<ReconcileResult, "failed" | "needsDecision">> | undefined): Promise<Array<{ stage: string; openedAtMs: number }>> {
  const ids = [...(r?.failed ?? []), ...(r?.needsDecision ?? [])];
  const opened: Array<{ stage: string; openedAtMs: number }> = [];
  for (const id of ids) {
    const stage = await getStage(db, id);
    if (!stage) continue;
    const state = await recordBreakerEvent(db, stage.name, "failure");
    if (state.justOpened && state.openedAtMs !== null) opened.push({ stage: stage.name, openedAtMs: state.openedAtMs });
  }
  return opened;
}
