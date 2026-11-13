import type pg from "pg";
import { dueLimitRuns, markResumed } from "@/server/db/engine-runs";
import { rerunStage, NO_DECISIONS, type EnqueueOnly, type PipelineReaders } from "@/server/db/pipeline";
import type { StageName } from "@/server/core/pipeline-plan";

// The engine's pause-and-resume (ADR 0015): a step stopped by the Claude usage limit failed with EngineLimitError (a known
// failure, so the retry sweep leaves it alone). Once its resume time has passed, this queues the same step again through the
// normal rerun path. Each paused run is claimed once (markResumed), so two sweeps never queue it twice; a video that is no
// longer live, or a step that cannot run again, is simply left as it is.

export async function resumeLimitedSteps(db: pg.Pool, queue: EnqueueOnly, readers: PipelineReaders = NO_DECISIONS, now: Date = new Date()): Promise<number> {
  let queued = 0;
  for (const due of await dueLimitRuns(db, now)) {
    if (!(await markResumed(db, due.runId))) continue;
    const row = (await db.query<{ name: string }>("select name from stage_runs where id = $1 and video_id = $2", [due.stageRunId, due.videoId])).rows[0];
    if (!row) continue;
    try {
      const r = await rerunStage(db, queue, due.videoId, row.name as StageName, readers);
      if (r.enqueued.length + r.enqueueFailed.length > 0) queued += 1;
    } catch {
      // not live any more, already running, or nothing to redo: nothing to resume
    }
  }
  return queued;
}
