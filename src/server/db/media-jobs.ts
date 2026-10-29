import type pg from "pg";
import { uuidv7 } from "@/server/core/ids";
import type { MediaArtifact } from "@/server/providers/media-types";

type Db = pg.Pool | pg.PoolClient;

export type MediaJobState = "submitting" | "submitted" | "done" | "failed_known" | "unknown";
export interface MediaJob {
  id: string;
  stageRunId: string;
  step: number;
  provider: string;
  kind: string;
  providerJobId: string | null;
  state: MediaJobState;
  quoteMicroUsd: number;
  actualMicroUsd: number | null;
  artifact: MediaArtifact | null;
}

const COLS = `id, stage_run_id as "stageRunId", step, provider, kind, provider_job_id as "providerJobId", state,
  quote_micro_usd::float8 as "quoteMicroUsd", actual_micro_usd::float8 as "actualMicroUsd", artifact`;

/** Records the job BEFORE any call. A second call for the same (stage run, step) gets the existing row and created=false. */
export async function submitOnce(
  db: Db,
  key: { stageRunId: string; step: number },
  provider: string,
  kind: string,
  quoteMicroUsd: number,
): Promise<{ job: MediaJob; created: boolean }> {
  const ins = await db.query<MediaJob>(
    `insert into media_jobs (id, stage_run_id, step, provider, kind, quote_micro_usd) values ($1, $2, $3, $4, $5, $6)
     on conflict (stage_run_id, step) do nothing returning ${COLS}`,
    [uuidv7(), key.stageRunId, key.step, provider, kind, quoteMicroUsd],
  );
  if (ins.rows[0]) return { job: ins.rows[0], created: true };
  const { rows } = await db.query<MediaJob>(`select ${COLS} from media_jobs where stage_run_id = $1 and step = $2`, [key.stageRunId, key.step]);
  return { job: rows[0]!, created: false };
}

/** Stored once, only from `submitting`. Returns false if it was already stored or the job moved on. */
export async function storeProviderJobId(db: Db, id: string, providerJobId: string): Promise<boolean> {
  const r = await db.query(
    `update media_jobs set provider_job_id = $2, state = 'submitted', updated_at = now()
     where id = $1 and state = 'submitting' and provider_job_id is null`,
    [id, providerJobId],
  );
  return r.rowCount === 1;
}

export async function finishJob(db: Db, id: string, r: { actual: number; artifact: MediaArtifact }): Promise<boolean> {
  const res = await db.query(
    `update media_jobs set state = 'done', actual_micro_usd = $2, artifact = $3, updated_at = now()
     where id = $1 and state in ('submitting', 'submitted')`,
    [id, r.actual, JSON.stringify(r.artifact)],
  );
  return res.rowCount === 1;
}

export async function markJobUnknown(db: Db, id: string): Promise<boolean> {
  const r = await db.query(
    `update media_jobs set state = 'unknown', updated_at = now() where id = $1 and state in ('submitting', 'submitted')`,
    [id],
  );
  return r.rowCount === 1;
}
