import type pg from "pg";
import type { EngineRunKind } from "@/server/engine/args";

// Rows of the new video engine's Claude Code runs (ADR 0015, migration 0086): usage per run and the usage-limit pauses.

type Q = pg.Pool | pg.PoolClient;
export type EngineRunStatus = "succeeded" | "failed" | "killed" | "limit";
export interface EngineUsage {
  inputTokens: number;
  outputTokens: number;
  /** The API-equivalent cost Claude Code reports. Nothing is billed: the run uses the owner's subscription. */
  costUsdEquiv: number;
}

/** Starts a run. Refused ("busy") while another run of the same video is still running (unique partial index). */
export async function startEngineRun(db: Q, r: { videoId: string; stageRunId: string; kind: EngineRunKind }): Promise<{ ok: true; id: string } | { ok: false; reason: "busy" }> {
  const res = await db.query<{ id: string }>(
    "insert into engine_runs (video_id, stage_run_id, kind) values ($1, $2, $3) on conflict (video_id) where status = 'running' do nothing returning id",
    [r.videoId, r.stageRunId, r.kind],
  );
  const id = res.rows[0]?.id;
  return id ? { ok: true, id } : { ok: false, reason: "busy" };
}

/** Ends a running run. A `limit` run must carry its resume time (checked by the table too). */
export async function finishEngineRun(db: Q, id: string, r: { status: EngineRunStatus; usage?: EngineUsage; turns?: number; resumeAt?: Date; error?: string }): Promise<void> {
  if (r.status === "limit" && !r.resumeAt) throw new Error("a limit run needs a resume time");
  await db.query(
    `update engine_runs set status = $2, ended_at = clock_timestamp(), input_tokens = $3, output_tokens = $4, cost_usd_equiv = $5, turns = $6, resume_at = $7, error = $8
      where id = $1 and status = 'running'`,
    [id, r.status, r.usage?.inputTokens ?? null, r.usage?.outputTokens ?? null, r.usage?.costUsdEquiv ?? null, r.turns ?? null, r.status === "limit" ? r.resumeAt : null, r.error?.slice(0, 500) ?? null],
  );
}

/** Limit-paused runs whose resume time has come and that were not resumed yet. */
export async function dueLimitRuns(db: Q, now: Date): Promise<Array<{ runId: string; videoId: string; stageRunId: string }>> {
  const res = await db.query<{ id: string; video_id: string; stage_run_id: string }>(
    "select id, video_id, stage_run_id from engine_runs where status = 'limit' and resumed_at is null and resume_at <= $1 order by resume_at, id",
    [now],
  );
  return res.rows.map((x) => ({ runId: x.id, videoId: x.video_id, stageRunId: x.stage_run_id }));
}

/** Marks a paused run as resumed exactly once; false when another sweep got there first. */
export async function markResumed(db: Q, runId: string): Promise<boolean> {
  const res = await db.query("update engine_runs set resumed_at = clock_timestamp() where id = $1 and status = 'limit' and resumed_at is null", [runId]);
  return res.rowCount === 1;
}

/** Usage of runs that ended at or after `since`. */
export async function usageWindow(db: Q, since: Date): Promise<{ runs: number; inputTokens: number; outputTokens: number; costUsdEquiv: number }> {
  const res = await db.query<{ runs: number; i: string; o: string; c: string }>(
    "select count(*)::int as runs, coalesce(sum(input_tokens), 0)::text as i, coalesce(sum(output_tokens), 0)::text as o, coalesce(sum(cost_usd_equiv), 0)::text as c from engine_runs where ended_at >= $1",
    [since],
  );
  const r = res.rows[0]!;
  return { runs: r.runs, inputTokens: Number(r.i), outputTokens: Number(r.o), costUsdEquiv: Number(r.c) };
}
