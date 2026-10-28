import type pg from "pg";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import { LeaseLostError, type ClaimLike } from "@/server/core/paid-call";
import { approvalState } from "./approvals";
import type { ContentKind } from "./videos";

// What the later stages (Build ... QA) save and read. Saving is fenced like Draft's: one transaction that first proves the
// caller still holds the stage (running, same fence, same owner), so a stale worker writes nothing.

export type ContentSave =
  | { kind: ContentKind; body: unknown }
  | { kind: ContentKind; filePath: string; sha256: string };

/** Idempotent per stage run: a stage that saved, crashed and runs again does not add a second version of the same kind. */
export async function saveStageContent(db: pg.Pool, videoId: string, claim: ClaimLike, items: readonly ContentSave[]): Promise<Record<string, number>> {
  const client = await db.connect();
  try {
    await client.query("begin");
    const gate = await client.query(
      "select 1 from stage_runs where id = $1 and status = 'running' and fence = $2 and lease_owner = $3 for share",
      [claim.stageRunId, claim.fence, claim.workerId],
    );
    if (gate.rowCount === 0) throw new LeaseLostError(`stage content:${claim.stageRunId}`);
    const versions: Record<string, number> = {};
    for (const item of items) {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`video_content:${videoId}:${item.kind}`]);
      const have = await client.query<{ version: number }>(
        "select version from video_content where video_id = $1 and kind = $2 and produced_by = $3 order by version desc limit 1",
        [videoId, item.kind, claim.stageRunId],
      );
      if (have.rows[0]) {
        versions[item.kind] = have.rows[0].version;
        continue;
      }
      const fileBased = "filePath" in item;
      const sha = fileBased ? item.sha256 : sha256Hex(canonicalJson(item.body));
      const ins = await client.query<{ version: number }>(
        `insert into video_content (video_id, kind, version, sha256, body, file_path, produced_by)
         values ($1, $2, (select coalesce(max(version), 0) + 1 from video_content where video_id = $1 and kind = $2), $3, $4, $5, $6)
         returning version`,
        [videoId, item.kind, sha, fileBased ? null : JSON.stringify(item.body), fileBased ? item.filePath : null, claim.stageRunId],
      );
      versions[item.kind] = ins.rows[0]!.version;
    }
    await client.query("commit");
    return versions;
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export type ApprovedCostPlan = { ok: true; hash: string; body: unknown } | { ok: false; reason: string };

/**
 * The cost plan the owner approved, exactly: the approval row names the content version it was computed from, and that
 * version's body is returned (not whatever is newest). Not approved, or changed since, is a plain refusal.
 */
export async function approvedCostPlan(db: pg.Pool, videoId: string): Promise<ApprovedCostPlan> {
  const state = await approvalState(db, videoId, "cost");
  const ref = state.approved ? state.versions.cost_plan : undefined;
  if (!state.approved || !ref) return { ok: false, reason: "The cost plan is not approved, or it changed after you approved it. Approve it again." };
  const r = await db.query<{ body: unknown }>("select body from video_content where id = $1 and video_id = $2 and kind = 'cost_plan'", [ref.id, videoId]);
  return r.rows[0] ? { ok: true, hash: state.hash, body: r.rows[0].body } : { ok: false, reason: "The approved cost plan could not be found." };
}
