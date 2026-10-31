import type pg from "pg";
import { BUDGET_DEFAULTS } from "@/server/core/settings-registry";
import { BREAKER_STAGES, type BreakerStage } from "@/server/core/queue-input";
import { ACTIVITY_EVENT_TYPES, attentionKind, mergeActivity, sortAttention, type ActivityItem, type ActivityRow, type AttentionRow, type SpendFigure } from "@/server/core/home-view";
import { breakerHold } from "./breakers";
import { listBudgetTemplates } from "./budget-scopes";

// What the Home screen reads, one bounded query per panel (Doc 4 section 2, "/"). Read only. Every function takes a limit
// so a long history never makes Home slow; Home shows the first rows and says how many more there are.

export async function loadAttention(db: pg.Pool, limit = 50): Promise<{ rows: AttentionRow[]; total: number }> {
  const r = await db.query<{ k: string; video_id: string; topic: string; stage: string | null; at: Date; budget: boolean; open_intent: boolean; total: string }>(
    `select *, count(*) over () as total from (
       select 'failed' as k, sr.video_id, v.topic, sr.name as stage, sr.updated_at as at, false as budget, false as open_intent
         from stage_runs sr join videos v on v.id = sr.video_id
        where sr.status = 'failed' and v.status in ('active', 'waiting', 'failed')
          and not exists (select 1 from stage_runs n where n.video_id = sr.video_id and n.name = sr.name and (n.created_at, n.id) > (sr.created_at, sr.id))
       union all
       select 'parked', sr.video_id, v.topic, sr.name, sr.updated_at,
              coalesce(sr.result->>'needsDecision', '') like 'budget_refused%',
              exists (select 1 from spend_intents si where si.stage_run_id = sr.id and si.status in ('pending', 'unknown'))
         from stage_runs sr join videos v on v.id = sr.video_id
        where sr.status = 'needs_decision' and v.status in ('active', 'waiting')
       union all
       select 'upload', u.video_id, v.topic, null::text, u.updated_at, false, false
         from uploads u join videos v on v.id = u.video_id
        where u.status = 'upload_failed'
          and not exists (select 1 from uploads n where n.video_id = u.video_id and (n.created_at, n.id) > (u.created_at, u.id))
     ) x order by at, video_id limit $1`,
    [limit],
  );
  const rows = r.rows.map((x): AttentionRow => ({
    kind: attentionKind({ upload: x.k === "upload", failed: x.k === "failed", budgetRefused: x.budget, openIntent: x.open_intent }),
    videoId: x.video_id,
    topic: x.topic,
    stage: x.stage,
    at: x.at,
  }));
  return { rows: sortAttention(rows), total: r.rows.length ? Number(r.rows[0]!.total) : 0 };
}

export interface BreakerHold {
  stage: BreakerStage;
  until: Date | null;
}
export async function loadBreakers(db: pg.Pool): Promise<BreakerHold[]> {
  const out: BreakerHold[] = [];
  for (const stage of BREAKER_STAGES) {
    const hold = await breakerHold(db, stage);
    if (hold) out.push({ stage, until: hold.until });
  }
  return out;
}

export interface ActiveRun {
  videoId: string;
  topic: string;
  language: string;
  stage: string;
  since: Date;
}
/** Stage runs that are running right now, oldest first. There is no percent or time left in the data, so none is made up. */
export async function loadActive(db: pg.Pool, limit = 10): Promise<ActiveRun[]> {
  const r = await db.query<{ video_id: string; topic: string; language: string; name: string; created_at: Date }>(
    `select sr.video_id, v.topic, v.language, sr.name, sr.created_at
       from stage_runs sr join videos v on v.id = sr.video_id
      where sr.status = 'running' and v.status in ('active', 'waiting')
      order by sr.created_at, sr.id limit $1`,
    [limit],
  );
  return r.rows.map((x) => ({ videoId: x.video_id, topic: x.topic, language: x.language, stage: x.name, since: x.created_at }));
}

export interface UpNextVideo {
  videoId: string;
  topic: string;
  language: string;
  stage: string;
  queuedAt: Date;
}
/** Videos with a queued step and nothing running, oldest first (their turn comes in this order). */
export async function loadUpNext(db: pg.Pool, limit = 10): Promise<UpNextVideo[]> {
  const r = await db.query<{ video_id: string; topic: string; language: string; name: string; created_at: Date }>(
    `select distinct on (sr.video_id) sr.video_id, v.topic, v.language, sr.name, sr.created_at
       from stage_runs sr join videos v on v.id = sr.video_id
      where sr.status = 'queued' and v.status in ('active', 'waiting')
        and not exists (select 1 from stage_runs x where x.video_id = sr.video_id and x.status = 'running')
      order by sr.video_id, sr.created_at, sr.id`,
  );
  return r.rows
    .map((x) => ({ videoId: x.video_id, topic: x.topic, language: x.language, stage: x.name, queuedAt: x.created_at }))
    .sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime() || a.videoId.localeCompare(b.videoId))
    .slice(0, limit);
}

/** The last `limit` things that happened: the live-feed events (without log and notice rows) and the audit trail (without sign-in rows). */
export async function loadRecent(db: pg.Pool, limit = 15): Promise<ActivityItem[]> {
  const [ev, au] = await Promise.all([
    db.query<{ at: Date; type: string; video_id: string | null; topic: string | null; stage: string | null; gate: string | null }>(
      `select e.at, e.type, e.video_id, v.topic, sr.name as stage, e.payload->>'gate' as gate
         from events e left join videos v on v.id = e.video_id left join stage_runs sr on sr.id = e.stage_run_id
        where e.type = any($1::text[]) order by e.id desc limit $2`,
      [ACTIVITY_EVENT_TYPES, limit],
    ),
    db.query<{ at: Date; event: string }>("select at, event from audit_log where event not like 'login.%' order by id desc limit $1", [limit]),
  ]);
  const rows: Array<ActivityRow & { videoId: string | null }> = [
    ...ev.rows.map((e) => ({ at: e.at, source: "event" as const, type: e.type, topic: e.topic, stage: e.stage, gate: e.gate, videoId: e.video_id })),
    ...au.rows.map((a) => ({ at: a.at, source: "audit" as const, type: a.event, topic: null, stage: null, gate: null, videoId: null })),
  ];
  return mergeActivity(rows, limit);
}

export interface HomeKpis {
  inProduction: number;
  madeThisWeek: number;
  publishedThisMonth: number;
  today: SpendFigure;
  month: SpendFigure;
}
/** Counts straight from the tables, caps from the budget templates (a missing template uses the default; null is "no limit"). */
export async function loadKpis(db: pg.Pool): Promise<HomeKpis> {
  const [c, b] = await Promise.all([
    db.query<{ prod: string; week: string; pub: string }>(
      `select (select count(*) from videos where status in ('active', 'waiting')) as prod,
              (select count(*) from videos where created_at >= now() - interval '7 days') as week,
              (select count(*) from uploads where status = 'uploaded'
                  and coalesce(finished_at, updated_at) >= date_trunc('month', now() at time zone 'utc') at time zone 'utc') as pub`,
    ),
    listBudgetTemplates(db),
  ]);
  const cap = (scope: "day" | "month"): number | null => {
    const t = b.templates.find((x) => x.scope === scope);
    return t ? t.capMicroUsd : BUDGET_DEFAULTS[scope]!;
  };
  const row = c.rows[0]!;
  return {
    inProduction: Number(row.prod),
    madeThisWeek: Number(row.week),
    publishedThisMonth: Number(row.pub),
    today: { spentMicroUsd: b.today.spentMicroUsd, capMicroUsd: cap("day") },
    month: { spentMicroUsd: b.month.spentMicroUsd, capMicroUsd: cap("month") },
  };
}
