import type pg from "pg";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import type { Script } from "@/server/core/script-contract";
import { addContent, type ContentKind, type VideoFormat, type VideoKind, type VideoLanguage } from "./videos";

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
 * Saves the draft as script / beats / evidence versions. Idempotent per stage run: a stage that crashed after saving and
 * runs again does not add a second set of versions (the kind is already produced by this stage run).
 */
export async function saveDraftContent(db: pg.Pool, videoId: string, stageRunId: string, script: Script): Promise<Record<string, number>> {
  const parts: Array<[ContentKind, unknown]> = [
    ["script", { title: script.title, ...(script.description !== undefined ? { description: script.description } : {}), narration: script.narration }],
    ["beats", { beats: script.beats }],
    ["evidence", { claims: script.evidence }],
  ];
  const versions: Record<string, number> = {};
  for (const [kind, body] of parts) {
    const have = await db.query<{ version: number }>(
      "select version from video_content where video_id = $1 and kind = $2 and produced_by = $3 order by version desc limit 1",
      [videoId, kind, stageRunId],
    );
    if (have.rows[0]) {
      versions[kind] = have.rows[0].version;
      continue;
    }
    const { version } = await addContent(db, videoId, kind, { body, sha256: sha256Hex(canonicalJson(body)), producedBy: stageRunId });
    versions[kind] = version;
  }
  return versions;
}

/**
 * The budget scopes one Draft run reserves against. The seeded rows (`draft_run`, `video:<kind>`, `day`, `month`) are
 * templates: each run, video and calendar period gets its own copy with the same cap, so a cap limits one run, one video,
 * one UTC day, one UTC month (not everything ever spent). Missing template = nothing is reserved and the stage fails.
 */
export async function ensureDraftScopes(db: pg.Pool, a: { stageRunId: string; videoId: string; kind: VideoKind }): Promise<string[]> {
  const t = await db.query<{ day: string; month: string }>(
    "select to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD') as day, to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM') as month",
  );
  const { day, month } = t.rows[0]!;
  const pairs: Array<[string, string]> = [
    [`draft_run:${a.stageRunId}`, "draft_run"],
    [`video:${a.videoId}`, `video:${a.kind}`],
    [`day:${day}`, "day"],
    [`month:${month}`, "month"],
  ];
  await db.query(
    `insert into budgets (scope, cap_micro_usd)
     select p.scope, b.cap_micro_usd from unnest($1::text[], $2::text[]) as p(scope, template) join budgets b on b.scope = p.template
     on conflict (scope) do nothing`,
    [pairs.map((p) => p[0]), pairs.map((p) => p[1])],
  );
  const have = await db.query<{ scope: string }>("select scope from budgets where scope = any($1::text[])", [pairs.map((p) => p[0])]);
  if (have.rowCount !== pairs.length) throw new Error("budget caps for Draft are not set up");
  return pairs.map((p) => p[0]);
}
