import type pg from "pg";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import { uuidv7 } from "@/server/core/ids";
import type { SeoBody } from "@/server/core/seo";
import { recordAudit } from "./audit";
import { inTx, type EnqueueOnly } from "./pipeline";
import { approvedScript } from "./stage-content";
import { latestContent } from "./videos";

export type SeoRequest = { ok: true; stageRunId: string } | { ok: false; message: string };

/**
 * Owner asked for (new) titles. Only queues the on-demand `seo` stage; the worker pays under ctx.paid ($0 on the Claude Code route).
 * Needs an approved script. One run at a time per video. Asking again queues a fresh run: a new `titles` content version.
 */
export async function requestSeo(db: pg.Pool, queue: EnqueueOnly, videoId: string, sessionId?: string): Promise<SeoRequest> {
  const out = await inTx(db, async (c): Promise<SeoRequest & { hash?: string }> => {
    const v = await c.query<{ status: string }>("select status from videos where id = $1 for update", [videoId]);
    if (!v.rows[0]) return { ok: false, message: "That video was not found." };
    if (v.rows[0].status === "cancelled") return { ok: false, message: "This video was cancelled." };
    const s = await approvedScript(db, videoId);
    if (!s.ok) return { ok: false, message: s.reason };
    const busy = await c.query("select 1 from stage_runs where video_id = $1 and name = 'seo' and status in ('queued', 'running', 'needs_decision')", [videoId]);
    if (busy.rowCount) return { ok: false, message: "Titles are already being written for this video." };
    const n = await c.query<{ n: string }>("select count(*)::text as n from stage_runs where video_id = $1 and name = 'seo'", [videoId]);
    const hash = sha256Hex(canonicalJson({ stage: "seo", script: s.hash, n: Number(n.rows[0]!.n) }));
    const id = uuidv7();
    const ins = await c.query("insert into stage_runs (id, video_id, name, status, input_hash) values ($1, $2, 'seo', 'queued', $3) on conflict do nothing", [id, videoId, hash]);
    if (!ins.rowCount) return { ok: false, message: "Titles were just requested. Look again." };
    return { ok: true, stageRunId: id, hash };
  });
  if (!out.ok) return out;
  await recordAudit(db, "seo.requested", { videoId, stageRunId: out.stageRunId, sessionId });
  // After the commit. If Redis is down the row stays queued and the reconciler enqueues it.
  await queue.enqueue(out.stageRunId, 0, 0, out.hash!).catch(() => undefined);
  return { ok: true, stageRunId: out.stageRunId };
}

export interface SeoTab {
  body: SeoBody | null;
  /** the approved script changed after these were written */
  stale: boolean;
  /** an approved script exists to write for */
  canWrite: boolean;
  /** a run is queued or running */
  busy: boolean;
}

export async function loadSeoTab(db: pg.Pool, videoId: string): Promise<SeoTab> {
  const row = await latestContent(db, videoId, "titles");
  const b = row?.body as Partial<SeoBody> | null | undefined;
  const body = b && b.version === 1 && Array.isArray(b.options) ? (b as SeoBody) : null;
  const s = await approvedScript(db, videoId);
  const busy = await db.query("select 1 from stage_runs where video_id = $1 and name = 'seo' and status in ('queued', 'running', 'needs_decision')", [videoId]);
  return { body, stale: body !== null && s.ok && body.scriptHash !== s.hash, canWrite: s.ok, busy: (busy.rowCount ?? 0) > 0 };
}
