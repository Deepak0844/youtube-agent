import type pg from "pg";
import { parseCutoutOptions, type CutoutOptions } from "@/server/core/cutout";
import { cutoutJobsFor, sweepStaleCutouts, type CutoutJob } from "@/server/db/cutout-jobs";
import { CutoutRefused, makeCutout, type CutoutDeps } from "@/server/db/cutouts";

// Worker only: this module loads the picture and model code, which the web process never does (cutout-jobs.ts is the light half the pages use).

/** Takes the oldest queued job and makes it. Returns null when nothing is queued. Never throws for a refused picture: the sentence goes on the row. */
export async function runNextCutout(db: pg.Pool, deps: CutoutDeps, signal?: AbortSignal): Promise<CutoutJob | null> {
  await sweepStaleCutouts(db);
  const claimed = await db.query<{ id: string; asset_id: string; options: CutoutOptions }>(
    `update cutout_jobs set status = 'running', updated_at = now()
      where id = (select id from cutout_jobs where status = 'queued' order by created_at limit 1 for update skip locked)
      returning id, asset_id, options`,
  );
  const job = claimed.rows[0];
  if (!job) return null;
  let status: "done" | "failed" = "done";
  let resultId: string | null = null;
  let error: string | null = null;
  try {
    const parsed = parseCutoutOptions(job.options as unknown as Record<string, unknown>); // checked again: the row is data, not trust
    if (!parsed.ok) throw new CutoutRefused(parsed.message);
    resultId = (await makeCutout(db, deps, job.asset_id, parsed.value, signal)).id;
  } catch (e) {
    status = "failed";
    error = (e instanceof CutoutRefused ? e.message : "The cut-out could not be made.").slice(0, 500);
  }
  await db.query("update cutout_jobs set status = $2, result_asset_id = $3, error = $4, updated_at = now() where id = $1", [job.id, status, resultId, error]);
  const [row] = await cutoutJobsFor(db, job.asset_id, 1);
  return row ?? null;
}
