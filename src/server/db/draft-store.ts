import type pg from "pg";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import type { Script } from "@/server/core/script-contract";
import { LeaseLostError, type ClaimLike } from "@/server/core/paid-call";
import { ensureScopeCopies, periodScopes, videoTemplate } from "./budget-scopes";
import type { ContentKind, VideoFormat, VideoKind, VideoLanguage } from "./videos";

// SQL for Draft (Phase 2 Task 17): which mode the routed model uses, what the owner asked for, and saving the result.

export type DraftMode = "agent" | "search_then_write";

/** The `draft_mode` of the model routed to a stage. No route, or an unknown value, means the safe mode. */
export async function draftModeForStage(db: pg.Pool, stage: string): Promise<DraftMode> {
  const r = await db.query<{ draft_mode: string }>(
    "select m.draft_mode from llm_routes r join llm_models m on m.id = r.model_id where r.stage = $1",
    [stage],
  );
  return r.rows[0]?.draft_mode === "agent" ? "agent" : "search_then_write";
}

export interface DraftVideo {
  format: VideoFormat;
  kind: VideoKind;
  language: VideoLanguage;
  topic: string;
  notes: string | null;
}

export async function loadDraftVideo(db: pg.Pool, videoId: string): Promise<DraftVideo | null> {
  const r = await db.query("select format, kind, language, topic, notes from videos where id = $1", [videoId]);
  return (r.rows[0] as DraftVideo | undefined) ?? null;
}

/** The note of the latest "send back" at the script gate, if it is newer than the latest script version (not yet addressed). */
export async function pendingScriptFeedback(db: pg.Pool, videoId: string): Promise<string | null> {
  const r = await db.query<{ note: string }>(
    `select a.note from approvals a
      where a.video_id = $1 and a.gate = 'script' and a.decision = 'sent_back'
        and a.decided_at > coalesce((select max(created_at) from video_content where video_id = $1 and kind = 'script'), '-infinity'::timestamptz)
      order by a.seq desc limit 1`,
    [videoId],
  );
  return r.rows[0]?.note ?? null;
}

/**
 * Saves the draft as script / beats / evidence versions, all in ONE transaction that first checks the caller still holds
 * the stage (running, same fence, same owner): a stale worker writes nothing. Idempotent per stage run: a stage that
 * crashed after saving and runs again does not add a second set of versions.
 */
export async function saveDraftContent(db: pg.Pool, videoId: string, claim: ClaimLike, script: Script): Promise<Record<string, number>> {
  const parts: Array<[ContentKind, unknown]> = [
    ["script", { title: script.title, ...(script.description !== undefined ? { description: script.description } : {}), narration: script.narration }],
    ["beats", { beats: script.beats }],
    ["evidence", { claims: script.evidence }],
  ];
  const client = await db.connect();
  try {
    await client.query("begin");
    const gate = await client.query(
      "select 1 from stage_runs where id = $1 and status = 'running' and fence = $2 and lease_owner = $3 for share",
      [claim.stageRunId, claim.fence, claim.workerId],
    );
    if (gate.rowCount === 0) throw new LeaseLostError(`draft content:${claim.stageRunId}`);
    const versions: Record<string, number> = {};
    for (const [kind, body] of parts) {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`video_content:${videoId}:${kind}`]);
      const have = await client.query<{ version: number }>(
        "select version from video_content where video_id = $1 and kind = $2 and produced_by = $3 order by version desc limit 1",
        [videoId, kind, claim.stageRunId],
      );
      if (have.rows[0]) {
        versions[kind] = have.rows[0].version;
        continue;
      }
      const ins = await client.query<{ version: number }>(
        `insert into video_content (video_id, kind, version, sha256, body, produced_by)
         values ($1, $2, (select coalesce(max(version), 0) + 1 from video_content where video_id = $1 and kind = $2), $3, $4, $5)
         returning version`,
        [videoId, kind, sha256Hex(canonicalJson(body)), JSON.stringify(body), claim.stageRunId],
      );
      versions[kind] = ins.rows[0]!.version;
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

/** The budget scopes one Draft run reserves against: this run, this video (long videos use the video:long cap), this UTC day and month. */
export async function ensureDraftScopes(db: pg.Pool, a: { stageRunId: string; videoId: string; kind: VideoKind; format: VideoFormat }): Promise<string[]> {
  return ensureScopeCopies(db, [
    [`draft_run:${a.stageRunId}`, "draft_run"],
    [`video:${a.videoId}`, videoTemplate(a.kind, a.format)],
    ...(await periodScopes(db)),
  ]);
}
