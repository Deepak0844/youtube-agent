import pg from "pg";
import { uuidv7 } from "@/server/core/ids";
import { stageJobId } from "@/server/core/job-id";

// Fenced stage execution. Every lease/expiry comparison uses the DATABASE clock (clock_timestamp(), which keeps
// moving inside a long transaction, unlike now()), never the app clock, so workers on different machines agree. The fence only ever grows
// (one bump per successful claim); every write by a worker is gated on its fence + owner.

// Any exported function can join a caller's transaction by passing its PoolClient.
export type Db = pg.Pool | pg.PoolClient;

export const MIN_LEASE_MS = 1;
export const MAX_LEASE_MS = 86_400_000; // 24 h

function assertTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_LEASE_MS || ttlMs > MAX_LEASE_MS) {
    throw new RangeError(`ttlMs must be an integer in [${MIN_LEASE_MS}, ${MAX_LEASE_MS}], got ${ttlMs}`);
  }
}

// Runs fn atomically: its own transaction on a Pool, or a savepoint inside the caller's transaction on a client.
export async function atomic<T>(
  db: Db,
  fn: (q: pg.ClientBase | pg.PoolClient) => Promise<T>,
  opts: { isolation?: "read committed" } = {},
): Promise<T> {
  if (db instanceof pg.Pool) {
    const client = await db.connect();
    try {
      await client.query(opts.isolation ? `begin isolation level ${opts.isolation}` : "begin");
      try {
        const out = await fn(client);
        await client.query("commit");
        return out;
      } catch (err) {
        await client.query("rollback").catch(() => {});
        throw err;
      }
    } finally {
      client.release();
    }
  }
  await db.query("savepoint stage_atomic");
  try {
    const out = await fn(db);
    await db.query("release savepoint stage_atomic");
    return out;
  } catch (err) {
    await db.query("rollback to savepoint stage_atomic").catch(() => {});
    throw err;
  }
}

export interface Claim {
  stageRunId: string;
  fence: number;
  workerId: string;
  leaseUntil: Date;
  jobId: string; // informational: stageJobId(id, fence, attempt_seq) = stage.<id>.<fence>.<attempt_seq>
}

export interface StageRow {
  id: string;
  videoId: string;
  name: string;
  status: string;
  inputHash: string;
  fence: number;
  attemptSeq: number;
  leaseOwner: string | null;
  leaseUntil: Date | null;
  attemptJobId: string | null;
  cancelRequested: boolean;
  result: unknown;
  createdAt: Date;
  updatedAt: Date;
}

// pg returns bigint as string; fail loudly rather than lose precision.
export function toNumber(v: string | number): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`bigint out of safe range: ${v}`);
  return n;
}

export async function insertQueuedStage(
  db: Db,
  args: { videoId: string; name: string; inputHash: string },
): Promise<string> {
  const id = uuidv7();
  await db.query(
    "insert into stage_runs (id, video_id, name, status, input_hash) values ($1,$2,$3,'queued',$4)",
    [id, args.videoId, args.name, args.inputHash],
  );
  return id;
}

// One conditional UPDATE: no read-then-write. Only a queued row whose input_hash matches and that nobody asked to
// cancel can be claimed: a QUEUED row cannot start spending after a cancel request. A row already running keeps
// spending until its worker honours the flag (later task).
export async function claimStage(
  db: Db,
  args: { id: string; inputHash: string; workerId: string; ttlMs: number; maxConcurrent?: number; maxRenders?: number; renderStageNames?: readonly string[] },
): Promise<Claim | null> {
  assertTtl(args.ttlMs);
  if (args.maxConcurrent !== undefined && (!Number.isSafeInteger(args.maxConcurrent) || args.maxConcurrent < 1)) throw new RangeError("maxConcurrent must be a positive integer");
  if (args.maxRenders !== undefined && (!Number.isSafeInteger(args.maxRenders) || args.maxRenders < 1)) throw new RangeError("maxRenders must be a positive integer");
  // One conditional UPDATE; the conversion check runs inside the same transaction, so a value that
  // cannot be represented rolls the claim back instead of leaving a committed-but-unreported lease.
  return atomic(db, async (q) => {
    if (args.maxConcurrent !== undefined || args.maxRenders !== undefined) {
      // Serialise admission across worker processes. Do not claim/refence a refused row: reconciliation delivers
      // a new attempt after capacity returns. Expired leases do not consume capacity (DB clock remains truth).
      await q.query("select pg_advisory_xact_lock(hashtext('ytstudio.stage-admission'))");
      const renders = args.renderStageNames ?? ["render"];
      const count = await q.query<{ n: number; renders: number }>(
        "select count(*)::int as n, count(*) filter (where name = any($1::text[]))::int as renders from stage_runs where status = 'running' and lease_until > clock_timestamp()", [renders],
      );
      if (args.maxConcurrent !== undefined && count.rows[0]!.n >= args.maxConcurrent) return null;
      if (args.maxRenders !== undefined && count.rows[0]!.renders >= args.maxRenders) {
        const target = await q.query<{ name: string }>("select name from stage_runs where id = $1", [args.id]);
        if (target.rows[0] && renders.includes(target.rows[0].name)) return null;
      }
    }
    const { rows } = await q.query<{ fence: string; lease_until: Date; attempt_seq: number }>(
      `update stage_runs
          set status = 'running',
              lease_owner = $3,
              lease_until = clock_timestamp() + ($4::bigint * interval '1 millisecond'),
              fence = fence + 1,
              updated_at = now()
        where id = $1 and status = 'queued' and input_hash = $2 and not cancel_requested
          and (not_before is null or not_before <= clock_timestamp())
    returning fence, lease_until, attempt_seq`,
      [args.id, args.inputHash, args.workerId, args.ttlMs],
    );
    const row = rows[0];
    if (!row) return null;
    const fence = toNumber(row.fence);
    if (!(row.lease_until instanceof Date) || Number.isNaN(row.lease_until.getTime())) {
      throw new Error("claim returned an invalid lease_until");
    }
    return {
      stageRunId: args.id,
      fence,
      workerId: args.workerId,
      leaseUntil: row.lease_until,
      jobId: stageJobId(args.id, fence, row.attempt_seq),
    };
  });
}

// Extends the lease only for the current fence+owner and only while it has not expired
// (once expired, the reconciler may already have acted, so it cannot be revived).
export async function heartbeat(db: Db, claim: Claim, ttlMs: number): Promise<boolean> {
  assertTtl(ttlMs);
  const res = await db.query(
    `update stage_runs
        set lease_until = clock_timestamp() + ($4::bigint * interval '1 millisecond'),
            updated_at = now()
      where id = $1 and status = 'running' and fence = $2 and lease_owner = $3 and lease_until > clock_timestamp()`,
    [claim.stageRunId, claim.fence, claim.workerId, ttlMs],
  );
  return res.rowCount === 1;
}

// The fence is the gate; the reconciler invalidates a claim by changing status/fence, not by the clock.
export async function commitStage(db: Db, claim: Claim, result: unknown): Promise<boolean> {
  const res = await db.query(
    `update stage_runs
        set status = 'succeeded', result = $4::jsonb, updated_at = now()
      where id = $1 and status = 'running' and fence = $2 and lease_owner = $3`,
    [claim.stageRunId, claim.fence, claim.workerId, JSON.stringify(result ?? null)],
  );
  return res.rowCount === 1;
}

// errorClass "transient" is stored in the result: it is the evidence scheduleRetry (db/retry.ts) needs that the provider
// refused the request before doing any work. Every other class leaves the result exactly as before.
export async function failStage(db: Db, claim: Claim, reason: string, errorClass?: string): Promise<boolean> {
  const res = await db.query(
    `update stage_runs
        set status = 'failed', result = $4::jsonb, updated_at = now()
      where id = $1 and status = 'running' and fence = $2 and lease_owner = $3`,
    [claim.stageRunId, claim.fence, claim.workerId, JSON.stringify(errorClass === "transient" ? { error: reason, class: "transient" } : { error: reason })],
  );
  return res.rowCount === 1;
}

// Parks the stage for a human/reconciler decision. Gated on fence + owner exactly like commitStage: a stale
// worker must not flip a stage that has moved on.
export async function markStageNeedsDecision(db: Db, claim: Claim, reason: string): Promise<boolean> {
  const res = await db.query(
    `update stage_runs
        set status = 'needs_decision', result = $4::jsonb, updated_at = now()
      where id = $1 and status = 'running' and fence = $2 and lease_owner = $3`,
    [claim.stageRunId, claim.fence, claim.workerId, JSON.stringify({ needsDecision: reason })],
  );
  return res.rowCount === 1;
}

export type StopStageOutcome = "cancelled" | "failed" | "needs_decision" | "rejected";

async function stopStage(
  db: Db,
  claim: Claim,
  mode: "cancelled" | "failed",
  reason: string,
): Promise<StopStageOutcome> {
  return atomic(db, async (q) => {
    const live = await q.query(
      `select id from stage_runs
        where id = $1 and status = 'running' and fence = $2 and lease_owner = $3
        for update`,
      [claim.stageRunId, claim.fence, claim.workerId],
    );
    if (live.rowCount !== 1) return "rejected";
    const open = await q.query(
      `select id from spend_intents
        where stage_run_id = $1 and status in ('pending', 'unknown')
        order by id for update`,
      [claim.stageRunId],
    );
    if (open.rowCount! > 0) {
      await q.query(
        "update spend_intents set status = 'unknown', updated_at = clock_timestamp() where stage_run_id = $1 and status = 'pending'",
        [claim.stageRunId],
      );
      await q.query(
        "update stage_runs set status = 'needs_decision', result = $2::jsonb, updated_at = clock_timestamp() where id = $1",
        [claim.stageRunId, JSON.stringify({ needsDecision: reason })],
      );
      return "needs_decision";
    }
    await q.query(
      "update stage_runs set status = $2, result = $3::jsonb, updated_at = clock_timestamp() where id = $1",
      [claim.stageRunId, mode, mode === "failed" ? JSON.stringify({ error: reason }) : null],
    );
    return mode;
  });
}

export function cancelStage(db: Db, claim: Claim): Promise<"cancelled" | "needs_decision" | "rejected"> {
  return stopStage(db, claim, "cancelled", "cancel requested while a paid call of unknown outcome is open") as Promise<"cancelled" | "needs_decision" | "rejected">;
}

export function timeoutStage(
  db: Db,
  claim: Claim,
  reason: "stage_timeout" | "provider_timeout",
): Promise<"failed" | "needs_decision" | "rejected"> {
  return stopStage(db, claim, "failed", reason) as Promise<"failed" | "needs_decision" | "rejected">;
}

// Sets the flag only; it is the running worker (or reconciler) that acts on it. Only live rows are flagged:
// a finished row (succeeded, failed, cancelled) is never touched. false = nothing was flagged.
export async function requestCancel(db: Db, stageRunId: string): Promise<boolean> {
  const res = await db.query(
    `update stage_runs set cancel_requested = true, updated_at = now()
      where id = $1 and status in ('queued', 'running', 'needs_decision')`,
    [stageRunId],
  );
  return res.rowCount === 1;
}

// A queued row with the cancel flag can never be claimed (see claimStage), so it is moved on here instead of waiting
// forever. Lock order stage row -> intents (same as the reconciler). A row holding an open (pending/unknown) paid call
// is never "cancelled" (that would hide held money): its pending intents become unknown and it parks as
// needs_decision. "skip" = nothing changed (not queued, or no flag).
export type CancelQueuedOutcome = "cancelled" | "needs_decision" | "skip";
export async function cancelQueuedStage(db: Db, stageRunId: string): Promise<CancelQueuedOutcome> {
  return atomic(db, async (q) => {
    const locked = await q.query(
      "select id from stage_runs where id = $1 and status = 'queued' and cancel_requested for update",
      [stageRunId],
    );
    if (locked.rowCount !== 1) return "skip";
    const open = await q.query(
      `select id from spend_intents where stage_run_id = $1 and status not in ('done', 'failed_known')
        order by id for update`,
      [stageRunId],
    );
    if (open.rowCount! > 0) {
      await q.query(
        "update spend_intents set status = 'unknown', updated_at = clock_timestamp() where stage_run_id = $1 and status = 'pending'",
        [stageRunId],
      );
      await q.query(
        "update stage_runs set status = 'needs_decision', result = $2::jsonb, updated_at = clock_timestamp() where id = $1",
        [stageRunId, JSON.stringify({ needsDecision: "cancel requested while a paid call of unknown outcome is open" })],
      );
      return "needs_decision";
    }
    await q.query("update stage_runs set status = 'cancelled', updated_at = clock_timestamp() where id = $1", [
      stageRunId,
    ]);
    return "cancelled";
  });
}

export async function getStage(db: Db, id: string): Promise<StageRow | null> {
  const { rows } = await db.query(
    `select id, video_id, name, status, input_hash, fence, attempt_seq, lease_owner, lease_until,
            attempt_job_id, cancel_requested, result, created_at, updated_at
       from stage_runs where id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    videoId: r.video_id,
    name: r.name,
    status: r.status,
    inputHash: r.input_hash,
    fence: toNumber(r.fence),
    attemptSeq: r.attempt_seq,
    leaseOwner: r.lease_owner,
    leaseUntil: r.lease_until,
    attemptJobId: r.attempt_job_id,
    cancelRequested: r.cancel_requested,
    result: r.result,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
