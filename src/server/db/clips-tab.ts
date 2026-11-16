import type pg from "pg";
import type { ClipBatchBody } from "@/server/core/clip-batch";
import { latestContent } from "./videos";

export interface ClipsTabClip {
  id: string;
  hook: string;
  durationS: number;
  /** a path relative to the storage root, for a signed preview link (the caller signs it) */
  file: string;
  warnings: string[];
  /** the Short already made from this clip, if any */
  short: { id: string; topic: string; status: string } | null;
}
export interface ClipsTab {
  /** QA finished, so clips can be cut */
  canCut: boolean;
  /** a run is queued or running */
  busy: boolean;
  /** a plain sentence when the newest run failed, else null */
  failure: string | null;
  batch: number | null;
  clips: ClipsTabClip[];
  needAttention: number;
}

/** Everything the Clips tab shows for a source video: the newest batch, each clip's warnings, and the Shorts already made from it. Read only. */
export async function loadClipsTab(db: pg.Pool, videoId: string): Promise<ClipsTab> {
  const qa = await db.query("select 1 from stage_runs where video_id = $1 and name = 'qa' and status = 'succeeded' limit 1", [videoId]);
  const runs = await db.query<{ status: string; result: { error?: unknown } | null }>(
    "select status, result from stage_runs where video_id = $1 and name = 'clips' order by created_at desc, id desc limit 1",
    [videoId],
  );
  const run = runs.rows[0];
  const busy = run !== undefined && ["queued", "running", "needs_decision"].includes(run.status);
  const failure = run?.status === "failed" ? (typeof run.result?.error === "string" ? run.result.error.replace(/^known_failure:\s*/, "").slice(0, 300) : "The last attempt to cut clips failed.") : null;
  const body = (await latestContent(db, videoId, "clip_batch"))?.body as ClipBatchBody | undefined;
  if (!body || !Array.isArray(body.clips)) return { canCut: (qa.rowCount ?? 0) > 0, busy, failure, batch: null, clips: [], needAttention: 0 };
  const shorts = await db.query<{ id: string; topic: string; status: string; clip_id: string }>(
    "select id, topic, status, clip_id from videos where clip_of = $1 and clip_batch = $2",
    [videoId, body.batch],
  );
  const madeBy = new Map(shorts.rows.map((s) => [s.clip_id, { id: s.id, topic: s.topic, status: s.status }]));
  const reviewOf = new Map(body.review.clips.map((r) => [r.id, r]));
  return {
    canCut: (qa.rowCount ?? 0) > 0,
    busy,
    failure,
    batch: body.batch,
    needAttention: body.review.needAttention,
    clips: body.clips.map((c) => ({ id: c.id, hook: c.hook, durationS: c.durationS, file: `videos/${videoId}/${c.file}`, warnings: reviewOf.get(c.id)?.warnings ?? [], short: madeBy.get(c.id) ?? null })),
  };
}
