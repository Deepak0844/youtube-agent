import type pg from "pg";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import { uuidv7 } from "@/server/core/ids";
import { recordAudit } from "./audit";
import { inTx, type EnqueueOnly } from "./pipeline";

export type ClipsRequest = { ok: true; stageRunId: string } | { ok: false; message: string };

/**
 * The owner asked for a batch of short clips from a finished video (Clip Factory, CF4a). Only queues the on-demand `clips` stage:
 * free and local (ffmpeg and the locked renderer; no model, no voice, no money). The source is any video whose checks finished
 * (QA succeeded, or an uploaded video that was prepared) and has caption words. One run at a time per video; asking again makes a NEW batch (old batches stay).
 * Nothing is published or approved here: the batch waits for the owner's gate (CF4b).
 */
export async function requestClips(db: pg.Pool, queue: EnqueueOnly, videoId: string, sessionId?: string): Promise<ClipsRequest> {
  const out = await inTx(db, async (c): Promise<ClipsRequest & { hash?: string }> => {
    const v = await c.query<{ status: string }>("select status from videos where id = $1 for update", [videoId]);
    if (!v.rows[0]) return { ok: false, message: "That video was not found." };
    if (v.rows[0].status === "cancelled") return { ok: false, message: "This video was cancelled." };
    const done = await c.query("select 1 from stage_runs where video_id = $1 and name in ('qa', 'ingest_source') and status = 'succeeded' limit 1", [videoId]);
    if (!done.rowCount) return { ok: false, message: "Clips can be cut only from a video that has finished and passed its checks." };
    const busy = await c.query("select 1 from stage_runs where video_id = $1 and name = 'clips' and status in ('queued', 'running', 'needs_decision')", [videoId]);
    if (busy.rowCount) return { ok: false, message: "Clips are already being cut from this video." };
    const n = await c.query<{ n: string }>("select count(*)::text as n from stage_runs where video_id = $1 and name = 'clips'", [videoId]);
    const hash = sha256Hex(canonicalJson({ stage: "clips", n: Number(n.rows[0]!.n) }));
    const id = uuidv7();
    const ins = await c.query("insert into stage_runs (id, video_id, name, status, input_hash) values ($1, $2, 'clips', 'queued', $3) on conflict do nothing", [id, videoId, hash]);
    if (!ins.rowCount) return { ok: false, message: "Clips were just requested. Look again." };
    return { ok: true, stageRunId: id, hash };
  });
  if (!out.ok) return out;
  await recordAudit(db, "clips.requested", { videoId, stageRunId: out.stageRunId, sessionId });
  // After the commit. If Redis is down the row stays queued and the reconciler enqueues it.
  await queue.enqueue(out.stageRunId, 0, 0, out.hash!).catch(() => undefined);
  return { ok: true, stageRunId: out.stageRunId };
}
