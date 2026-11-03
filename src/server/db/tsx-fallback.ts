import type pg from "pg";
import { LeaseLostError, type ClaimLike } from "@/server/core/paid-call";
import { recordAudit } from "@/server/db/audit";

/**
 * A code-scene video whose scene file could not be made switches to the scene kit. One transaction that first proves the
 * caller still holds the stage (running, same fence, same owner), so a stale worker switches nothing. `kind_origin` keeps the
 * video's parameters hash on 'tsx', so Draft, the owner's script approval and every earlier stage stay up to date; only the
 * route changes (the next advance queues Build). Also needs a live lease and no cancel request (same test as promoteAttempt). Returns false when the video was not a tsx video any more (already switched).
 * The audit detail holds counts and a reason class, never source text.
 */
export async function fallBackToSceneKit(db: pg.Pool, claim: ClaimLike, videoId: string, detail: { attempts: number; step: string; why: string }): Promise<boolean> {
  const client = await db.connect();
  try {
    await client.query("begin");
    // Lock order is the same as lockVideo (videos row, then stage_runs) so this cannot deadlock with advance/rerun/cancel.
    const v = await client.query<{ kind: string; kind_origin: string | null }>("select kind, kind_origin from videos where id = $1 for update", [videoId]);
    const gate = await client.query(
      "select 1 from stage_runs where id = $1 and video_id = $2 and status = 'running' and fence = $3 and lease_owner = $4 and lease_until > clock_timestamp() and not cancel_requested for update",
      [claim.stageRunId, videoId, claim.fence, claim.workerId],
    );
    if (gate.rowCount === 0) throw new LeaseLostError(`tsx fallback:${claim.stageRunId}`);
    const u = v.rows[0]?.kind === "tsx" ? await client.query("update videos set kind = 'scene_kit', kind_origin = 'tsx', updated_at = now() where id = $1 and kind = 'tsx'", [videoId]) : { rowCount: 0 };
    if (u.rowCount === 1) await recordAudit(client, "video.tsx_fallback", { videoId, attempts: detail.attempts, step: detail.step, why: detail.why });
    await client.query("commit");
    return u.rowCount === 1;
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
