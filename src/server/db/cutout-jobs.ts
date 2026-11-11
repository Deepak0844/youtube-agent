import type pg from "pg";
import { parseCutoutOptions } from "@/server/core/cutout";
import { recordAudit } from "@/server/db/audit";
import { getAsset } from "@/server/db/assets";

export const MAX_QUEUED_CUTOUTS = 5;
/** A running row older than this belongs to a worker that died. */
export const STALE_AFTER_MINUTES = 15;

export interface CutoutJob {
  id: string;
  assetId: string;
  status: "queued" | "running" | "done" | "failed";
  resultAssetId: string | null;
  error: string | null;
  method: string;
  createdAt: Date;
}

/** Owner asks for a cut-out. Checked now (so a typo shows at once) and again when the worker runs it. Returns the job id. */
export async function queueCutout(db: pg.Pool, assetId: string, raw: Record<string, unknown>): Promise<{ ok: true; jobId: string } | { ok: false; message: string }> {
  const o = parseCutoutOptions(raw);
  if (!o.ok) return o;
  const asset = await getAsset(db, assetId).catch(() => null);
  if (!asset || asset.deletedAt) return { ok: false, message: "That picture does not exist." };
  if (asset.kind !== "image") return { ok: false, message: "Only a picture can be cut out." };
  const open = await db.query<{ n: number }>("select count(*)::int as n from cutout_jobs where status in ('queued', 'running')");
  if (open.rows[0]!.n >= MAX_QUEUED_CUTOUTS) return { ok: false, message: `${MAX_QUEUED_CUTOUTS} cut-outs are already waiting. Try again when they are done.` };
  const r = await db.query<{ id: string }>("insert into cutout_jobs (asset_id, options) values ($1, $2::jsonb) returning id", [assetId, JSON.stringify(o.value)]);
  await recordAudit(db, "asset.cutout_queued", { assetId, method: o.value.method });
  return { ok: true, jobId: r.rows[0]!.id };
}

/** The picture's recent cut-out jobs, newest first. */
export async function cutoutJobsFor(db: pg.Pool, assetId: string, limit = 5): Promise<CutoutJob[]> {
  const { rows } = await db.query<{ id: string; asset_id: string; status: CutoutJob["status"]; result_asset_id: string | null; error: string | null; options: { method?: string }; created_at: Date }>(
    "select id, asset_id, status, result_asset_id, error, options, created_at from cutout_jobs where asset_id = $1 order by created_at desc limit $2",
    [assetId, limit],
  );
  return rows.map((r) => ({ id: r.id, assetId: r.asset_id, status: r.status, resultAssetId: r.result_asset_id, error: r.error, method: r.options.method ?? "model", createdAt: r.created_at }));
}

/** Worker start and every tick: a `running` row older than the limit was left by a worker that died, so it is failed (never silently retried). */
export async function sweepStaleCutouts(db: pg.Pool): Promise<number> {
  const r = await db.query(
    "update cutout_jobs set status = 'failed', error = 'The worker stopped while making this cut-out. Ask for it again.', updated_at = now() where status = 'running' and updated_at < now() - ($1 || ' minutes')::interval",
    [String(STALE_AFTER_MINUTES)],
  );
  return r.rowCount ?? 0;
}
