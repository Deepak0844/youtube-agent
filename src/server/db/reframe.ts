import type pg from "pg";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import { uuidv7 } from "@/server/core/ids";
import { isReframeFormat } from "@/server/core/reframe";
import { recordAudit } from "./audit";
import { inTx, type EnqueueOnly } from "./pipeline";

export type ReframeRequest = { ok: true; stageRunId: string } | { ok: false; message: string };

/**
 * Owner asked for a 16:9 / 1:1 version. Free (local ffmpeg): it only queues the on-demand `reframe` stage. Needs a finished
 * video (a `video` content version from the check step). Never touches final.mp4 or its hash. Asking again for the same
 * format queues a fresh run that replaces final-<fmt>.mp4; one run at a time per video.
 */
export async function requestReframe(db: pg.Pool, queue: EnqueueOnly, videoId: string, format: string, sessionId?: string): Promise<ReframeRequest> {
  if (!isReframeFormat(format)) return { ok: false, message: "Pick 16:9 or 1:1." };
  const out = await inTx(db, async (c): Promise<ReframeRequest & { hash?: string }> => {
    const v = await c.query<{ status: string }>("select status from videos where id = $1 for update", [videoId]);
    if (!v.rows[0]) return { ok: false, message: "That video was not found." };
    if (v.rows[0].status === "cancelled") return { ok: false, message: "This video was cancelled." };
    const fin = await c.query<{ sha256: string }>("select sha256 from video_content where video_id = $1 and kind = 'video' order by version desc limit 1", [videoId]);
    if (!fin.rows[0]) return { ok: false, message: "There is no finished video to re-frame yet." };
    const busy = await c.query("select 1 from stage_runs where video_id = $1 and name = 'reframe' and status in ('queued', 'running', 'needs_decision')", [videoId]);
    if (busy.rowCount) return { ok: false, message: "A re-frame is already queued or running for this video." };
    const n = await c.query<{ n: string }>("select count(*)::text as n from stage_runs where video_id = $1 and name = 'reframe'", [videoId]);
    const hash = sha256Hex(canonicalJson({ stage: "reframe", video: fin.rows[0].sha256, format, n: Number(n.rows[0]!.n) }));
    const id = uuidv7();
    const ins = await c.query("insert into stage_runs (id, video_id, name, status, input_hash, result) values ($1, $2, 'reframe', 'queued', $3, $4) on conflict do nothing", [id, videoId, hash, JSON.stringify({ request: { format } })]);
    if (!ins.rowCount) return { ok: false, message: "A re-frame was just requested. Look again." };
    return { ok: true, stageRunId: id, hash };
  });
  if (!out.ok) return out;
  await recordAudit(db, "video.reframe_requested", { videoId, format, stageRunId: out.stageRunId, sessionId });
  // After the commit. If Redis is down the row stays queued and the reconciler enqueues it.
  await queue.enqueue(out.stageRunId, 0, 0, out.hash!).catch(() => undefined);
  return { ok: true, stageRunId: out.stageRunId };
}
