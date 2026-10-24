import type pg from "pg";
import { uuidv7 } from "@/server/core/ids";

// Fenced stage execution. Every lease/expiry comparison uses the DATABASE clock (now()),
// never the app clock, so workers on different machines agree. The fence only ever grows
// (one bump per successful claim); every write by a worker is gated on its fence + owner.

export interface Claim {
  stageRunId: string;
  fence: number;
  workerId: string;
  leaseUntil: Date;
  jobId: string; // informational: stage:<id>:<fence>:<attempt_seq>
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
function toNumber(v: string | number): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`bigint out of safe range: ${v}`);
  return n;
}

export async function insertQueuedStage(
  pool: pg.Pool,
  args: { videoId: string; name: string; inputHash: string },
): Promise<string> {
  const id = uuidv7();
  await pool.query(
    "insert into stage_runs (id, video_id, name, status, input_hash) values ($1,$2,$3,'queued',$4)",
    [id, args.videoId, args.name, args.inputHash],
  );
  return id;
}

// One conditional UPDATE: no read-then-write. Only a queued row whose input_hash matches can be claimed.
export async function claimStage(
  pool: pg.Pool,
  args: { id: string; inputHash: string; workerId: string; ttlMs: number },
): Promise<Claim | null> {
  const { rows } = await pool.query<{ fence: string; lease_until: Date; attempt_seq: number }>(
    `update stage_runs
        set status = 'running',
            lease_owner = $3,
            lease_until = now() + ($4::bigint * interval '1 millisecond'),
            fence = fence + 1,
            updated_at = now()
      where id = $1 and status = 'queued' and input_hash = $2
  returning fence, lease_until, attempt_seq`,
    [args.id, args.inputHash, args.workerId, args.ttlMs],
  );
  const row = rows[0];
  if (!row) return null;
  const fence = toNumber(row.fence);
  return {
    stageRunId: args.id,
    fence,
    workerId: args.workerId,
    leaseUntil: row.lease_until,
    jobId: `stage:${args.id}:${fence}:${row.attempt_seq}`,
  };
}

// Extends the lease only for the current fence+owner and only while it has not expired
// (once expired, the reconciler may already have acted, so it cannot be revived).
export async function heartbeat(pool: pg.Pool, claim: Claim, ttlMs: number): Promise<boolean> {
  const res = await pool.query(
    `update stage_runs
        set lease_until = now() + ($4::bigint * interval '1 millisecond'),
            updated_at = now()
      where id = $1 and status = 'running' and fence = $2 and lease_owner = $3 and lease_until > now()`,
    [claim.stageRunId, claim.fence, claim.workerId, ttlMs],
  );
  return res.rowCount === 1;
}

// The fence is the gate; the reconciler invalidates a claim by changing status/fence, not by the clock.
export async function commitStage(pool: pg.Pool, claim: Claim, result: unknown): Promise<boolean> {
  const res = await pool.query(
    `update stage_runs
        set status = 'succeeded', result = $4::jsonb, updated_at = now()
      where id = $1 and status = 'running' and fence = $2 and lease_owner = $3`,
    [claim.stageRunId, claim.fence, claim.workerId, JSON.stringify(result ?? null)],
  );
  return res.rowCount === 1;
}

export async function failStage(pool: pg.Pool, claim: Claim, reason: string): Promise<boolean> {
  const res = await pool.query(
    `update stage_runs
        set status = 'failed', result = $4::jsonb, updated_at = now()
      where id = $1 and status = 'running' and fence = $2 and lease_owner = $3`,
    [claim.stageRunId, claim.fence, claim.workerId, JSON.stringify({ error: reason })],
  );
  return res.rowCount === 1;
}

// Sets the flag only; it is the running worker (or reconciler) that acts on it.
export async function requestCancel(pool: pg.Pool, stageRunId: string): Promise<void> {
  await pool.query("update stage_runs set cancel_requested = true, updated_at = now() where id = $1", [
    stageRunId,
  ]);
}

export async function getStage(pool: pg.Pool, id: string): Promise<StageRow | null> {
  const { rows } = await pool.query(
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
