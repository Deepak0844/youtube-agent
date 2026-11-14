import type pg from "pg";
import type { EngineRunKind } from "@/server/engine/args";
import { estimateVideosLeft, WINDOW_MS } from "@/server/engine/usage";

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

/**
 * Runs of this video still marked running that no engine in this process is driving (`active`): a try that crashed before it
 * could end its run (a dropped database connection, say). Only one worker runs (the worker lock), so such a run is stale; it is
 * closed so the step can run again. A run this process is still driving is never touched. Returns how many were closed.
 */
export async function closeStaleRunsOf(db: Q, videoId: string, active: ReadonlySet<string>): Promise<number> {
  const res = await db.query(
    `update engine_runs set status = 'killed', ended_at = clock_timestamp(), error = 'An earlier try of this step stopped without finishing; the step ran again.'
      where video_id = $1 and status = 'running' and not (id::text = any($2::text[]))`,
    [videoId, [...active]],
  );
  return res.rowCount ?? 0;
}

/** At worker start: runs still marked running belong to a worker that is gone (its process group was swept). */
export async function killStaleEngineRuns(db: Q): Promise<number> {
  const res = await db.query("update engine_runs set status = 'killed', ended_at = clock_timestamp(), error = 'The worker restarted during this run.' where status = 'running'");
  return res.rowCount ?? 0;
}

/** Health's engine line: usage in the last 5 hours and, when it can be learned, how many more videos fit (an estimate). */
export async function engineUsageSummary(db: Q, now: Date = new Date()): Promise<{ runs: number; tokens: number; costUsdEquiv: number; videosLeft: number | null }> {
  const win = await usageWindow(db, new Date(now.getTime() - WINDOW_MS));
  const last = (await db.query<{ at: Date }>("select ended_at as at from engine_runs where status = 'limit' order by ended_at desc limit 1")).rows[0]?.at ?? null;
  // The window's size is learned from the last time the limit was hit: what was used in the 5 hours up to that moment.
  const capacity = last
    ? Number((await db.query<{ t: string }>("select coalesce(sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0)), 0)::text as t from engine_runs where ended_at > $1 and ended_at <= $2", [new Date(last.getTime() - WINDOW_MS), last])).rows[0]!.t)
    : null;
  const per = await db.query<{ t: string }>(
    `select sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0))::text as t from engine_runs where status = 'succeeded'
      group by video_id order by max(ended_at) desc limit 10`,
  );
  const tokens = win.inputTokens + win.outputTokens;
  return { runs: win.runs, tokens, costUsdEquiv: win.costUsdEquiv, videosLeft: estimateVideosLeft({ capacityTokens: capacity, usedTokens: tokens, perVideoTokens: per.rows.map((r) => Number(r.t)) }) };
}

/** Usage per engine step of one video (summed over its runs), for the video page. */
export async function engineUsageByStage(db: Q, videoId: string): Promise<Array<{ stage: string; inputTokens: number; outputTokens: number; costUsdEquiv: number; turns: number }>> {
  const r = await db.query<{ stage: string; i: string; o: string; c: string; t: string }>(
    `select s.name as stage, coalesce(sum(e.input_tokens), 0)::text as i, coalesce(sum(e.output_tokens), 0)::text as o, coalesce(sum(e.cost_usd_equiv), 0)::text as c, coalesce(sum(e.turns), 0)::text as t
       from engine_runs e join stage_runs s on s.id = e.stage_run_id where e.video_id = $1 and e.ended_at is not null group by s.name order by min(e.started_at)`,
    [videoId],
  );
  return r.rows.map((x) => ({ stage: x.stage, inputTokens: Number(x.i), outputTokens: Number(x.o), costUsdEquiv: Number(x.c), turns: Number(x.t) }));
}
