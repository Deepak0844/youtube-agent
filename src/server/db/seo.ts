import type pg from "pg";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import { uuidv7 } from "@/server/core/ids";
import type { SeoBody } from "@/server/core/seo";
import { DRY_RUN_NOTES } from "@/lib/dry-run";
import { recordAudit } from "./audit";
import { inTx, type EnqueueOnly } from "./pipeline";
import { approvedScript } from "./stage-content";
import { latestContent } from "./videos";

export type SeoRequest = { ok: true; stageRunId: string } | { ok: false; message: string };

/**
 * Owner asked for (new) titles. Only queues the on-demand `seo` stage; the worker pays under ctx.paid ($0 on the Claude Code route).
 * Needs an approved script. One run at a time per video. Asking again queues a fresh run: a new `titles` content version.
 */
export async function requestSeo(db: pg.Pool, queue: EnqueueOnly, videoId: string, sessionId?: string, opts: { firstOnly?: boolean } = {}): Promise<SeoRequest> {
  const out = await inTx(db, async (c): Promise<SeoRequest & { hash?: string }> => {
    const v = await c.query<{ status: string }>("select status from videos where id = $1 for update", [videoId]);
    if (!v.rows[0]) return { ok: false, message: "That video was not found." };
    if (v.rows[0].status === "cancelled") return { ok: false, message: "This video was cancelled." };
    const s = await approvedScript(db, videoId);
    if (!s.ok) return { ok: false, message: s.reason };
    const busy = await c.query("select 1 from stage_runs where video_id = $1 and name = 'seo' and status in ('queued', 'running', 'needs_decision')", [videoId]);
    if (busy.rowCount) return { ok: false, message: "Titles are already being written for this video." };
    const n = await c.query<{ n: string }>("select count(*)::text as n from stage_runs where video_id = $1 and name = 'seo'", [videoId]);
    if (opts.firstOnly && Number(n.rows[0]!.n) > 0) return { ok: false, message: "Titles were already requested for this video." };
    const hash = sha256Hex(canonicalJson({ stage: "seo", script: s.hash, n: Number(n.rows[0]!.n) }));
    const id = uuidv7();
    const ins = await c.query("insert into stage_runs (id, video_id, name, status, input_hash) values ($1, $2, 'seo', 'queued', $3) on conflict do nothing", [id, videoId, hash]);
    if (!ins.rowCount) return { ok: false, message: "Titles were just requested. Look again." };
    return { ok: true, stageRunId: id, hash };
  });
  if (!out.ok) return out;
  await recordAudit(db, opts.firstOnly ? "seo.auto_requested" : "seo.requested", { videoId, stageRunId: out.stageRunId, sessionId });
  // After the commit. If Redis is down the row stays queued and the reconciler enqueues it.
  await queue.enqueue(out.stageRunId, 0, 0, out.hash!).catch(() => undefined);
  return { ok: true, stageRunId: out.stageRunId };
}

/**
 * The first metadata draft: once a video has finished rendering (it waits at the video gate or later) and no titles were ever
 * requested, queue ONE `seo` run. Idempotent: the video row lock plus the "already requested" check mean a second sweep, or two
 * workers, add nothing. Never retries a failed draft by itself (the Titles tab button does). Dry-run videos are skipped.
 */
export async function autoSeoSweep(db: pg.Pool, queue: EnqueueOnly): Promise<string[]> {
  // Only videos whose QA finished in the last 7 days (a first deploy does not draft for every old video at once) and that have
  // a script approval on record. The approval is checked for real below, so a video whose script changed is skipped, not retried
  // by this query forever: it falls out of the 7-day window.
  const { rows } = await db.query<{ id: string }>(
    `select v.id from videos v
      where v.status in ('active', 'waiting') and v.notes is distinct from $1
        and exists (select 1 from stage_runs r where r.video_id = v.id and r.name = 'qa' and r.status = 'succeeded' and r.updated_at > now() - interval '7 days')
        and exists (select 1 from approvals a where a.video_id = v.id and a.gate = 'script' and a.decision = 'approved')
        and not exists (select 1 from stage_runs r where r.video_id = v.id and r.name = 'seo')
      order by v.updated_at limit 100`,
    [DRY_RUN_NOTES],
  );
  const queued: string[] = [];
  for (const { id } of rows) {
    if (queued.length >= 20) break;
    if (!(await approvedScript(db, id)).ok) continue; // the approval no longer matches the script
    const r = await requestSeo(db, queue, id, undefined, { firstOnly: true }).catch(() => ({ ok: false as const, message: "" }));
    if (r.ok) queued.push(r.stageRunId);
  }
  return queued;
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
