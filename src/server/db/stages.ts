import pg from "pg";
import { uuidv7 } from "@/server/core/ids";

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
export async function atomic<T>(db: Db, fn: (q: pg.ClientBase | pg.PoolClient) => Promise<T>): Promise<T> {
  if (db instanceof pg.Pool) {
    const client = await db.connect();
    try {
      await client.query("begin");
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

// One conditional UPDATE: no read-then-write. Only a queued row whose input_hash matches can be claimed.
export async function claimStage(
  db: Db,
  args: { id: string; inputHash: string; workerId: string; ttlMs: number },
): Promise<Claim | null> {
  assertTtl(args.ttlMs);
  // One conditional UPDATE; the conversion check runs inside the same transaction, so a value that
  // cannot be represented rolls the claim back instead of leaving a committed-but-unreported lease.
  return atomic(db, async (q) => {
    const { rows } = await q.query<{ fence: string; lease_until: Date; attempt_seq: number }>(
      `update stage_runs
          set status = 'running',
              lease_owner = $3,
              lease_until = clock_timestamp() + ($4::bigint * interval '1 millisecond'),
              fence = fence + 1,
              updated_at = now()
        where id = $1 and status = 'queued' and input_hash = $2
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
      jobId: `stage:${args.id}:${fence}:${row.attempt_seq}`,
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

export async function failStage(db: Db, claim: Claim, reason: string): Promise<boolean> {
  const res = await db.query(
    `update stage_runs
        set status = 'failed', result = $4::jsonb, updated_at = now()
      where id = $1 and status = 'running' and fence = $2 and lease_owner = $3`,
    [claim.stageRunId, claim.fence, claim.workerId, JSON.stringify({ error: reason })],
  );
  return res.rowCount === 1;
}

// Sets the flag only; it is the running worker (or reconciler) that acts on it.
export async function requestCancel(db: Db, stageRunId: string): Promise<void> {
  await db.query("update stage_runs set cancel_requested = true, updated_at = now() where id = $1", [
    stageRunId,
  ]);
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
