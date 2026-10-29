import type pg from "pg";
import { checkLimits, type AssetLimits, type LimitRefusal, type Rights, type StorageHolders } from "@/server/core/asset-rules";
import { getSetting } from "./settings";
import type { Db } from "./stages";

// SQL for ingest_jobs (migration 0030). The web process reserves a row before reading the body (rate, batch and storage
// checks run under one advisory lock, so parallel uploads cannot slip past a limit); the worker claims it exactly once.

export const RATE_PER_MINUTE = 60;
// A row stuck in `receiving` (the web process died mid-upload) stops holding storage after this long.
const RECEIVING_HOLD = "1 hour";

// A job that fails for a reason that is not the file's fault is put back this many times in total (the engine's own
// default stage tries, engine.retry_attempts = 3), then ended. A constant: this queue has no settings row of its own.
export const MAX_INGEST_TRIES = 3;

export type IngestStatus = "receiving" | "queued" | "running" | "done" | "rejected";
export interface IngestJob {
  id: string;
  batchId: string;
  status: IngestStatus;
  kind: "image" | "audio" | null;
  originalName: string;
  tags: string[];
  caption: string | null;
  keep: boolean;
  containsPerson: boolean;
  voiceClone: boolean;
  rights: Rights;
  assetId: string | null;
  reason: string | null;
  attempts: number;
}

interface Row {
  id: string; batch_id: string; status: IngestStatus; kind: IngestJob["kind"]; original_name: string; tags: string[]; caption: string | null;
  keep: boolean; contains_person: boolean; voice_clone: boolean; rights: Rights; asset_id: string | null; reason: string | null; attempts: number;
}
const toJob = (r: Row): IngestJob => ({
  id: r.id, batchId: r.batch_id, status: r.status, kind: r.kind, originalName: r.original_name, tags: r.tags, caption: r.caption, keep: r.keep,
  containsPerson: r.contains_person, voiceClone: r.voice_clone, rights: r.rights, assetId: r.asset_id, reason: r.reason, attempts: r.attempts,
});

export async function loadLimits(db: Db): Promise<AssetLimits> {
  const pool = db as pg.Pool;
  const [maxImageBytes, maxAudioBytes, maxPixels, maxBatchFiles, totalBytesCap] = await Promise.all(
    ["assets.max_image_bytes", "assets.max_audio_bytes", "assets.max_pixels", "assets.max_batch_files", "assets.total_bytes_cap"].map((k) => getSetting(pool, k) as Promise<number>),
  );
  return { maxImageBytes: maxImageBytes!, maxAudioBytes: maxAudioBytes!, maxPixels: maxPixels!, maxBatchFiles: maxBatchFiles!, totalBytesCap: totalBytesCap! };
}

export interface ReserveInput {
  id: string;
  batchId: string;
  originalName: string;
  declaredBytes: number;
  tags: string[];
  caption: string | null;
  keep: boolean;
  containsPerson: boolean;
  voiceClone: boolean;
  rights: Rights;
}
export type Reserved = { ok: true } | { ok: false; reason: "rate_limited" | LimitRefusal; holders?: StorageHolders };

/** Checks the rate limit, the batch count and the storage cap, then inserts the row (status `receiving`), all under one lock. */
export async function reserveIngestJob(pool: pg.Pool, a: ReserveInput, limits: AssetLimits): Promise<Reserved> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext('ingest_reserve'))");
    const { rows } = await client.query<{ recent: number; batch: number; stored: number; keep: number; trash: number }>(
      `select
         (select count(*) from ingest_jobs where created_at > now() - interval '1 minute')::int recent,
         (select count(*) from ingest_jobs where batch_id = $1)::int batch,
         (select coalesce(sum(bytes), 0) from assets)::float8
           + (select coalesce(sum(bytes), 0) from ingest_jobs
              where status in ('queued', 'running') or (status = 'receiving' and created_at > now() - interval '${RECEIVING_HOLD}'))::float8 stored,
         (select coalesce(sum(bytes), 0) from assets where keep and deleted_at is null)::float8 keep,
         (select coalesce(sum(bytes), 0) from assets where deleted_at is not null)::float8 trash`,
      [a.batchId],
    );
    const c = rows[0]!;
    let refusal: Reserved = { ok: true };
    if (c.recent >= RATE_PER_MINUTE) refusal = { ok: false, reason: "rate_limited" };
    else {
      const v = checkLimits(
        { bytes: a.declaredBytes, batchFiles: c.batch + 1, storedBytes: c.stored },
        { maxBytes: Math.max(limits.maxImageBytes, limits.maxAudioBytes), maxBatchFiles: limits.maxBatchFiles, totalBytesCap: limits.totalBytesCap },
      );
      if (!v.ok) refusal = { ok: false, reason: v.reason, ...(v.reason === "storage_full" && { holders: { keep: c.keep, seriesPins: 0, stuckVideos: 0, trash: c.trash } }) };
    }
    if (refusal.ok) {
      await client.query(
        `insert into ingest_jobs (id, batch_id, status, original_name, bytes, tags, caption, keep, contains_person, voice_clone, rights)
         values ($1, $2, 'receiving', $3, $4, $5::text[], $6, $7, $8, $9, $10::jsonb)`,
        [a.id, a.batchId, a.originalName, a.declaredBytes, a.tags, a.caption, a.keep, a.containsPerson, a.voiceClone, JSON.stringify(a.rights)],
      );
    }
    await client.query("commit");
    return refusal;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** The whole file arrived and passed the sniff: the job now waits for the worker. */
export async function markQueued(db: Db, id: string, kind: "image" | "audio", bytes: number): Promise<boolean> {
  const r = await db.query("update ingest_jobs set status = 'queued', kind = $2, bytes = $3, updated_at = now() where id = $1 and status = 'receiving'", [id, kind, bytes]);
  return r.rowCount === 1;
}

/** Ends a job that has not finished. `reason` is the plain sentence the owner reads; the space it held is released. */
export async function markRejected(db: Db, id: string, reason: string): Promise<void> {
  await db.query("update ingest_jobs set status = 'rejected', reason = $2, bytes = 0, updated_at = now() where id = $1 and status in ('receiving', 'running')", [id, reason]);
}

export async function markDone(db: Db, id: string, assetId: string): Promise<void> {
  await db.query("update ingest_jobs set status = 'done', asset_id = $2, bytes = 0, updated_at = now() where id = $1 and status = 'running'", [id, assetId]);
}

export async function getIngestJob(db: Db, id: string): Promise<IngestJob | null> {
  const { rows } = await db.query<Row>("select * from ingest_jobs where id = $1", [id]);
  return rows[0] ? toJob(rows[0]) : null;
}

/** The one-shot start: only a `queued` row can be claimed, so a redelivered or duplicate job finds nothing and does nothing. */
export async function claimIngestJob(db: Db, id: string): Promise<IngestJob | null> {
  const { rows } = await db.query<Row>("update ingest_jobs set status = 'running', attempts = attempts + 1, updated_at = now() where id = $1 and status = 'queued' returning *", [id]);
  return rows[0] ? toJob(rows[0]) : null;
}

/** Back to the queue (the spooled file is still there). Only a `running` row moves. */
export async function requeueJob(db: Db, id: string): Promise<void> {
  await db.query("update ingest_jobs set status = 'queued', updated_at = now() where id = $1 and status = 'running'", [id]);
}

export async function runningIngestIds(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>("select id from ingest_jobs where status = 'running'");
  return rows.map((r) => r.id);
}

/** The asset this job already registered, if any (its files live under assets/<jobId>/). */
export async function assetForJob(db: Db, jobId: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>("select id from assets where storage_ref like $1 limit 1", [`assets/${jobId}/%`]);
  return rows[0]?.id ?? null;
}

/** Uploads that never finished arriving (the web process died) are ended; returns their ids so the caller can remove partial files. */
export async function expireReceiving(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `update ingest_jobs set status = 'rejected', reason = 'The upload was interrupted. Try again.', bytes = 0, updated_at = now()
     where status = 'receiving' and created_at < now() - interval '${RECEIVING_HOLD}' returning id`,
  );
  return rows.map((r) => r.id);
}

export async function queuedIngestIds(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>("select id from ingest_jobs where status = 'queued' order by created_at limit 500");
  return rows.map((r) => r.id);
}
