import type pg from "pg";
import { stageJobId } from "@/server/core/job-id";
import type { JobQueue } from "@/server/queue/job-queue";
import { cancelQueuedStage, toNumber } from "./stages";

// Conservative reconciler (Doc 2 §4.2.7). Postgres is the truth; Redis may have been wiped. All time checks use the
// DATABASE clock (clock_timestamp()); there is deliberately no `now` parameter.
//
// A) running + expired lease. Per row, in ONE transaction, following the global lock order stage -> intents:
//    1. SELECT ... FROM stage_runs WHERE id=$1 FOR UPDATE                      (stage row locked FIRST)
//    2. a LATER statement reads that stage's intents NOT IN ('done','failed_known') FOR UPDATE. It must be a separate
//       statement: under READ COMMITTED a single UPDATE ... AND NOT EXISTS(pending) keeps its old snapshot for the
//       subquery after waiting on a concurrent reserve's FOR SHARE, and would requeue over a just-committed intent.
//    3. any such intent (pending OR unknown: markUnknown and markStageNeedsDecision are separate statements in the
//       paid-call wrapper, a death between them leaves running+unknown) -> pending intents become 'unknown'
//       (reservation kept) and the stage goes to needs_decision. Nothing is enqueued.
//       none -> conditional requeue (status/lease re-checked in the WHERE), which also bumps attempt_seq and sets
//       attempt_job_id; the job is enqueued only AFTER the commit.
// B) queued rows older than the grace window whose CURRENT attempt job (stage.<id>.<fence>.<attempt_seq>) is not
//    live in Redis -> one conditional UPDATE bumps attempt_seq (only if fence/attempt_seq are still what we saw, so
//    two concurrent reconcilers bump once), then enqueue with the row's current input_hash, after the commit.
//    The grace window keeps us off rows a creator is about to enqueue; a double enqueue anyway is safe (fenced claim).
// Attempt cap (maxAttempts, default 5): where A would requeue or B would re-enqueue a row whose
// attempt_seq >= maxAttempts, the SAME conditional statement (same locks, same WHERE) instead sets
// status='failed', result {"reason":"too_many_attempts","attempts":attempt_seq}. attempt_seq counts re-enqueues, so a
// stage gets at most 1 + maxAttempts deliveries. It bounds errors that leave no open intent (a throwing stepsFor,
// bugs); an open intent always wins (needs_decision), and needs_decision rows are never touched.
// Branch B at the cap checks for an open intent exactly like A (stage lock, then intents lock, separate statements):
// an open intent parks the row (pending -> unknown, needs_decision) instead of failing it.
// Queued rows with cancel_requested are moved to 'cancelled' (cancelQueuedStage) and never re-enqueued; claimStage
// refuses them anyway.
// An enqueue failure is recorded in enqueueFailed: the row stays queued with a fresh updated_at and the next
// reconcile after the grace window re-enqueues it.
// needs_decision (and succeeded/failed/cancelled) rows are never selected, so never touched.
// NOT handled here: a failed_known intent that still holds a reservation (late KnownFailure after another worker
// marked it unknown) — see the Task 5 report.

export const DEFAULT_GRACE_MS = 5_000;
// Cap semantics: the stage is failed when it WOULD be retried with attempt_seq >= maxAttempts. attempt_seq starts at 0
// and counts reconciler re-enqueues/requeues, so maxAttempts allows 1 + maxAttempts deliveries in total
// (default 5 => at most 6 deliveries: the original plus 5 retries). maxAttempts 0 => the original delivery only.
export const DEFAULT_MAX_ATTEMPTS = 5;

const tooMany = (attempts: number) => JSON.stringify({ reason: "too_many_attempts", attempts });

export interface ReconcileResult {
  requeued: string[];
  reenqueued: string[];
  needsDecision: string[];
  failed: string[];
  cancelled: string[];
  enqueueFailed: string[];
}

type Enqueuer = Pick<JobQueue, "enqueue" | "liveJobIds">;

type Decision =
  | { kind: "skip" }
  | { kind: "needs_decision" }
  | { kind: "failed" }
  | { kind: "requeued"; fence: number; attemptSeq: number; inputHash: string };

async function decideExpired(pool: pg.Pool, id: string, maxAttempts: number): Promise<Decision> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    try {
      const { rows } = await client.query<{ fence: string; attempt_seq: number; expired: boolean }>(
        `select fence, attempt_seq, (status = 'running' and lease_until < clock_timestamp()) as expired
           from stage_runs where id = $1 for update`,
        [id],
      );
      const stage = rows[0];
      if (!stage || !stage.expired) {
        await client.query("rollback");
        return { kind: "skip" };
      }
      const open = await client.query(
        `select id from spend_intents
          where stage_run_id = $1 and status not in ('done', 'failed_known')
          order by id for update`,
        [id],
      );
      let decision: Decision;
      if (open.rowCount! > 0) {
        await client.query(
          "update spend_intents set status = 'unknown', updated_at = clock_timestamp() where stage_run_id = $1 and status = 'pending'",
          [id],
        );
        const parked = await client.query(
          `update stage_runs
              set status = 'needs_decision', result = $2::jsonb, updated_at = clock_timestamp()
            where id = $1 and status = 'running' and lease_until < clock_timestamp()`,
          [id, JSON.stringify({ needsDecision: "reconciler: lease expired with a paid call of unknown outcome" })],
        );
        decision = parked.rowCount === 1 ? { kind: "needs_decision" } : { kind: "skip" };
      } else if (stage.attempt_seq >= maxAttempts) {
        const failed = await client.query(
          `update stage_runs set status = 'failed', result = $2::jsonb, updated_at = clock_timestamp()
            where id = $1 and status = 'running' and lease_until < clock_timestamp()
              and fence = $3 and attempt_seq = $4`,
          [id, tooMany(stage.attempt_seq), toNumber(stage.fence), stage.attempt_seq],
        );
        decision = failed.rowCount === 1 ? { kind: "failed" } : { kind: "skip" };
      } else {
        const fence = toNumber(stage.fence);
        const attemptSeq = stage.attempt_seq + 1;
        const requeued = await client.query<{ input_hash: string }>(
          `update stage_runs
              set status = 'queued', lease_owner = NULL, lease_until = NULL,
                  attempt_seq = attempt_seq + 1, attempt_job_id = $2, updated_at = clock_timestamp()
            where id = $1 and status = 'running' and lease_until < clock_timestamp()
              and fence = $3 and attempt_seq = $4
        returning input_hash`,
          [id, stageJobId(id, fence, attemptSeq), fence, stage.attempt_seq],
        );
        const row = requeued.rows[0];
        decision = row ? { kind: "requeued", fence, attemptSeq, inputHash: row.input_hash } : { kind: "skip" };
      }
      await client.query("commit");
      return decision;
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw err;
    }
  } finally {
    client.release();
  }
}

// Queued row at the attempt cap. Same lock order as A: stage row first, then its open intents in a LATER statement.
// An open (pending/unknown) intent means money may be held or spent: park it for a human, never fail it.
async function decideQueuedOverCap(
  pool: pg.Pool,
  id: string,
  fence: number,
  attemptSeq: number,
  graceMs: number,
): Promise<"failed" | "needs_decision" | "skip"> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    try {
      const locked = await client.query(
        `select id from stage_runs
          where id = $1 and status = 'queued' and not cancel_requested and fence = $2 and attempt_seq = $3
            and updated_at < clock_timestamp() - ($4::bigint * interval '1 millisecond')
          for update`,
        [id, fence, attemptSeq, graceMs],
      );
      if (locked.rowCount !== 1) {
        await client.query("rollback");
        return "skip";
      }
      const open = await client.query(
        `select id from spend_intents
          where stage_run_id = $1 and status not in ('done', 'failed_known')
          order by id for update`,
        [id],
      );
      let decision: "failed" | "needs_decision";
      if (open.rowCount! > 0) {
        await client.query(
          "update spend_intents set status = 'unknown', updated_at = clock_timestamp() where stage_run_id = $1 and status = 'pending'",
          [id],
        );
        await client.query(
          `update stage_runs set status = 'needs_decision', result = $2::jsonb, updated_at = clock_timestamp() where id = $1`,
          [id, JSON.stringify({ needsDecision: "reconciler: queued row over the attempt cap with a paid call of unknown outcome" })],
        );
        decision = "needs_decision";
      } else {
        await client.query(
          `update stage_runs set status = 'failed', result = $2::jsonb, updated_at = clock_timestamp() where id = $1`,
          [id, tooMany(attemptSeq)],
        );
        decision = "failed";
      }
      await client.query("commit");
      return decision;
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw err;
    }
  } finally {
    client.release();
  }
}

export async function reconcile(
  pool: pg.Pool,
  queue: Enqueuer,
  opts: { graceMs?: number; maxAttempts?: number } = {},
): Promise<ReconcileResult> {
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 0) throw new RangeError(`maxAttempts must be a non-negative integer, got ${maxAttempts}`);
  if (!Number.isSafeInteger(graceMs) || graceMs < 0) throw new RangeError(`graceMs must be a non-negative integer, got ${graceMs}`);
  const out: ReconcileResult = { requeued: [], reenqueued: [], needsDecision: [], failed: [], cancelled: [], enqueueFailed: [] };

  const enqueue = async (id: string, fence: number, attemptSeq: number, inputHash: string): Promise<boolean> => {
    try {
      await queue.enqueue(id, fence, attemptSeq, inputHash);
      return true;
    } catch {
      out.enqueueFailed.push(id);
      return false;
    }
  };

  // A) expired leases
  const expired = await pool.query<{ id: string }>(
    "select id from stage_runs where status = 'running' and lease_until < clock_timestamp() order by id",
  );
  for (const { id } of expired.rows) {
    const d = await decideExpired(pool, id, maxAttempts);
    if (d.kind === "needs_decision") out.needsDecision.push(id);
    if (d.kind === "failed") out.failed.push(id);
    if (d.kind === "requeued") {
      out.requeued.push(id); // committed; the enqueue comes strictly after
      await enqueue(id, d.fence, d.attemptSeq, d.inputHash);
    }
  }

  // B0) queued rows nobody may run any more: cancelled, never enqueued
  const doomed = await pool.query<{ id: string }>(
    "select id from stage_runs where status = 'queued' and cancel_requested order by id",
  );
  for (const { id } of doomed.rows) {
    const d = await cancelQueuedStage(pool, id);
    if (d === "cancelled") out.cancelled.push(id);
    if (d === "needs_decision") out.needsDecision.push(id);
  }

  // B) queued rows with no live job for their current attempt (rows requeued above are inside the grace window
  //    unless graceMs is 0, in which case their fresh job is live and they are skipped)
  const queued = await pool.query<{ id: string; fence: string; attempt_seq: number }>(
    `select id, fence, attempt_seq from stage_runs
      where status = 'queued' and not cancel_requested and updated_at < clock_timestamp() - ($1::bigint * interval '1 millisecond')
      order by id`,
    [graceMs],
  );
  if (queued.rows.length === 0) return out;
  const live = await queue.liveJobIds();
  for (const r of queued.rows) {
    const fence = toNumber(r.fence);
    if (live.has(stageJobId(r.id, fence, r.attempt_seq))) continue;
    if (r.attempt_seq >= maxAttempts) {
      const d = await decideQueuedOverCap(pool, r.id, fence, r.attempt_seq, graceMs);
      if (d === "failed") out.failed.push(r.id);
      if (d === "needs_decision") out.needsDecision.push(r.id);
      continue;
    }
    const attemptSeq = r.attempt_seq + 1;
    const bumped = await pool.query<{ input_hash: string }>(
      `update stage_runs
          set attempt_seq = attempt_seq + 1, attempt_job_id = $2, updated_at = clock_timestamp()
        where id = $1 and status = 'queued' and not cancel_requested and fence = $3 and attempt_seq = $4
          and updated_at < clock_timestamp() - ($5::bigint * interval '1 millisecond')
    returning input_hash`,
      [r.id, stageJobId(r.id, fence, attemptSeq), fence, r.attempt_seq, graceMs],
    );
    const row = bumped.rows[0];
    if (!row) continue; // someone else moved it (claimed, or another reconciler bumped it)
    if (await enqueue(r.id, fence, attemptSeq, row.input_hash)) out.reenqueued.push(r.id);
  }
  return out;
}
