import type pg from "pg";
import { MIN_SHORTS_FOR_SIGNAL, beatSpans, type Curve } from "@/server/core/analytics";
import {
  OPTIMIZER_CAP_USD, REVIEW_CAP_USD, buildReport, isoWeek, optimizerPrompt, parseObservations, parseProposals, reviewPrompt, shortBeatDrops,
  type ProposalKind, type ShortStat, type WeeklyReport,
} from "@/server/core/insights";
import { istParts } from "@/server/core/scheduler";
import { concludeTitleTest, type TitleTestResult, type Window } from "@/server/core/title-test";
import { recordAudit } from "./audit";
import { notifySafe, type NotifySend } from "./notify";

// Weekly review, learning inputs, optimizer proposals and title tests. Everything here is a record: nothing writes to YouTube,
// publishes, approves a gate or changes a policy. A model is reached only through the InsightsModel port.

export type By = { kind: "session"; sessionId: string } | { kind: "worker" };
const byDetail = (by: By) => ({ by: by.kind, sessionId: by.kind === "session" ? by.sessionId : null });

/** The one door to a text model for insights. The implementation must reserve and record the spend through the app's paid-call path and
 *  must refuse (throw ModelUnavailable) when the model is unpriced, missing or disabled. `maxUsd` is the cap for this one call. */
export interface InsightsModel {
  run(a: { kind: "review" | "optimizer" | "research"; prompt: string; maxUsd: number; /** research only: one attempt per period, so the caller counts runs into it */ period?: string }): Promise<{ text: string; costUsd: number }>;
}
/** A refusal with a plain sentence that is safe to show (no model, unpriced model, over budget). */
export class ModelUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelUnavailable";
  }
}
/** Used until a text model is wired to insights: numbers are still produced, only the model's part is skipped. */
export const noInsightsModel: InsightsModel = {
  run: async () => {
    throw new ModelUnavailable("no text model is connected to reviews yet");
  },
};

const micro = (usd: number) => Math.round(usd * 1_000_000);

interface Inputs { week: string; report: WeeklyReport; known: string[]; shorts: ShortStat[] }

/** All numbers a review needs, straight from the database. */
export async function loadInsightShorts(db: Pick<pg.Pool, "query">): Promise<ShortStat[]> {
  const { rows } = await db.query<{ video_id: string; topic: string; kind: string; language: string; views: string | null; pct: string | null; retention: Curve | null; spend: string }>(
    `select u.video_id, v.topic, v.kind, v.language, a.views::text as views, a.avg_view_pct::text as pct, a.retention,
            coalesce((select sum(si.actual_micro_usd) from spend_intents si join stage_runs sr on sr.id = si.stage_run_id where sr.video_id = u.video_id and si.status = 'done'), 0)::text as spend
       from (select distinct on (video_id) video_id from uploads where status = 'uploaded' and youtube_id is not null order by video_id, finished_at desc nulls last) u
       join videos v on v.id = u.video_id
       join lateral (select * from video_analytics x where x.video_id = u.video_id and x.error is null order by x.day desc limit 1) a on true
      order by v.created_at desc, u.video_id`,
  );
  const ids = rows.map((r) => r.video_id);
  const content = ids.length
    ? (await db.query<{ video_id: string; kind: string; body: unknown }>(
        "select distinct on (video_id, kind) video_id, kind, body from video_content where video_id = any($1::uuid[]) and kind in ('beats', 'scenes') and body is not null order by video_id, kind, version desc",
        [ids],
      )).rows
    : [];
  const body = (id: string, kind: string) => content.find((c) => c.video_id === id && c.kind === kind)?.body;
  return rows.map((r): ShortStat => {
    const curve = Array.isArray(r.retention) ? r.retention : [];
    const beats = (body(r.video_id, "beats") as { beats?: unknown } | undefined)?.beats;
    return {
      videoId: r.video_id, topic: r.topic, niche: `${r.kind} · ${r.language}`,
      views: r.views === null ? null : Number(r.views), avgViewPct: r.pct === null ? null : Number(r.pct), spendMicroUsd: Number(r.spend),
      beatDrops: curve.length ? shortBeatDrops(curve, beatSpans(beats, body(r.video_id, "scenes"))) : {},
    };
  });
}

async function gather(db: pg.Pool, now: Date): Promise<Inputs> {
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const one = async (sql: string) => Number((await db.query<{ n: string }>(sql, [since])).rows[0]!.n);
  const [shipped, failures, spend, shorts] = await Promise.all([
    one("select count(distinct video_id)::text as n from uploads where status = 'uploaded' and finished_at >= $1"),
    one("select count(*)::text as n from stage_runs where status = 'failed' and updated_at >= $1"),
    one("select coalesce(sum(actual_micro_usd), 0)::text as n from spend_intents where status = 'done' and created_at >= $1"),
    loadInsightShorts(db),
  ]);
  const week = isoWeek(istParts(now).date);
  const report = buildReport({ week, shipped, failures, spendMicroUsd: spend, shorts });
  return { week, report, known: shorts.map((s) => s.videoId), shorts };
}

export interface ReviewResult { id: string; week: string; observations: number; costMicroUsd: number; message: string }

/** Builds this week's review (numbers from data, a model adds observations only) and stores it. A second run in the same week replaces it. */
export async function runWeeklyReview(db: pg.Pool, model: InsightsModel, by: By, opts: { now?: Date; send?: NotifySend } = {}): Promise<ReviewResult> {
  const now = opts.now ?? new Date();
  const { week, report } = await gather(db, now);
  let notes: string[];
  let cost = 0;
  if (report.shortsWithData < MIN_SHORTS_FOR_SIGNAL) {
    notes = [`Only ${report.shortsWithData} short${report.shortsWithData === 1 ? "" : "s"} ${report.shortsWithData === 1 ? "has" : "have"} analytics (fewer than ${MIN_SHORTS_FOR_SIGNAL}), so there are no observations yet, only the numbers.`];
  } else {
    try {
      const out = await model.run({ kind: "review", prompt: reviewPrompt(report), maxUsd: REVIEW_CAP_USD });
      cost = micro(Number.isFinite(out.costUsd) && out.costUsd > 0 ? out.costUsd : 0);
      notes = cost > micro(REVIEW_CAP_USD) ? ["(observations dropped: the model call cost more than the $0.20 cap)"] : parseObservations(out.text);
      if (notes.length === 0) notes = ["(the model gave no usable observations)"];
    } catch (e) {
      notes = [`(observations unavailable: ${e instanceof ModelUnavailable ? e.message : "the model call failed"})`];
    }
  }
  const { rows } = await db.query<{ id: string }>(
    `insert into reviews (week, data, notes, cost_micro_usd) values ($1, $2::jsonb, $3::jsonb, $4)
     on conflict (week) do update set data = excluded.data, notes = excluded.notes, cost_micro_usd = excluded.cost_micro_usd, created_at = now()
     returning id::text`,
    [week, JSON.stringify(report), JSON.stringify(notes), cost],
  );
  const id = rows[0]!.id;
  await recordAudit(db, "review.generated", { ...byDetail(by), week, shortsWithData: report.shortsWithData, modelUsed: cost > 0, costMicroUsd: cost });
  await notifySafe(db, opts.send, { event: "weekly_review_ready", from: "idle", to: "weekly_review_ready", transitionId: `review.${week}.${now.getTime()}`, detail: `${week}: ${report.shortsWithData} short(s) with data.` });
  return { id, week, observations: notes.length, costMicroUsd: cost, message: `Weekly review ${week} written (${report.shortsWithData} short${report.shortsWithData === 1 ? "" : "s"} with data).` };
}

export interface ReviewView { id: string; week: string; createdAt: Date; report: WeeklyReport; notes: string[]; costMicroUsd: number }
export async function latestReview(db: Pick<pg.Pool, "query">): Promise<ReviewView | null> {
  const { rows } = await db.query<{ id: string; week: string; created_at: Date; data: WeeklyReport; notes: string[]; cost: string }>(
    "select id::text, week, created_at, data, notes, cost_micro_usd::text as cost from reviews order by week desc limit 1",
  );
  const r = rows[0];
  return r ? { id: r.id, week: r.week, createdAt: r.created_at, report: r.data, notes: Array.isArray(r.notes) ? r.notes : [], costMicroUsd: Number(r.cost) } : null;
}

export interface OptimizerResult { made: number; costMicroUsd: number; message: string }
/** Proposals only. Silent (nothing made) below the minimum sample or when the model is not available; never throws for those. */
export async function runOptimizer(db: pg.Pool, model: InsightsModel, by: By, opts: { now?: Date } = {}): Promise<OptimizerResult> {
  const { report, known } = await gather(db, opts.now ?? new Date());
  const none = (message: string): OptimizerResult => ({ made: 0, costMicroUsd: 0, message });
  if (report.shortsWithData < MIN_SHORTS_FOR_SIGNAL) return none(`skipped: only ${report.shortsWithData} short(s) with analytics (needs ${MIN_SHORTS_FOR_SIGNAL})`);
  let out: { text: string; costUsd: number };
  try {
    out = await model.run({ kind: "optimizer", prompt: optimizerPrompt(report), maxUsd: OPTIMIZER_CAP_USD });
  } catch (e) {
    if (e instanceof ModelUnavailable) return none(`skipped: ${e.message}`);
    throw e;
  }
  const cost = micro(Number.isFinite(out.costUsd) && out.costUsd > 0 ? out.costUsd : 0);
  const overCap = cost > micro(OPTIMIZER_CAP_USD);
  const items = overCap ? [] : parseProposals(out.text, known);
  for (const p of items) {
    await db.query("insert into proposals (kind, video_id, title, detail, payload) values ($1, $2, $3, $4, $5::jsonb)", [p.kind, p.videoId, p.title, p.detail, JSON.stringify(p.payload)]);
  }
  await recordAudit(db, "optimizer.ran", { ...byDetail(by), made: items.length, costMicroUsd: cost, overCap });
  return { made: items.length, costMicroUsd: cost, message: overCap ? "the model call cost more than the cap, so its proposals were dropped" : `${items.length} proposal${items.length === 1 ? "" : "s"} written` };
}

export interface ProposalRow { id: string; kind: ProposalKind; videoId: string | null; topic: string | null; title: string; detail: string; status: "open" | "accepted" | "dismissed"; createdAt: Date }
export async function listProposals(db: Pick<pg.Pool, "query">, limit = 30): Promise<ProposalRow[]> {
  const { rows } = await db.query<{ id: string; kind: ProposalKind; video_id: string | null; topic: string | null; title: string; detail: string; status: ProposalRow["status"]; created_at: Date }>(
    `select p.id::text, p.kind, p.video_id, v.topic, p.title, p.detail, p.status, p.created_at
       from proposals p left join videos v on v.id = p.video_id
      order by (p.status = 'open') desc, p.created_at desc, p.id desc limit $1`,
    [limit],
  );
  return rows.map((r) => ({ id: r.id, kind: r.kind, videoId: r.video_id, topic: r.topic, title: r.title, detail: r.detail, status: r.status, createdAt: r.created_at }));
}

/** Accepting records the owner's decision and nothing else: no title, hook, idea or policy is changed anywhere. */
export async function decideProposal(db: pg.Pool, id: string, decision: "accept" | "dismiss", sessionId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!/^[0-9]{1,18}$/.test(id)) return { ok: false, error: "That proposal does not exist." };
  const { rows } = await db.query<{ kind: string }>(
    "update proposals set status = $2, decided_by = $3, decided_at = now() where id = $1::bigint and status = 'open' returning kind",
    [id, decision === "accept" ? "accepted" : "dismissed", `session:${sessionId}`],
  );
  if (!rows[0]) return { ok: false, error: "That proposal does not exist or was already decided." };
  await recordAudit(db, "proposal.decided", { proposalId: id, kind: rows[0].kind, decision, sessionId });
  return { ok: true };
}

// ---- title experiments: advisory, sequential, read from snapshots we already saved (no YouTube call) ----
export interface TitleExperiment { id: string; videoId: string; titleA: string; titleB: string; windowDays: number; status: string; phases: Array<Window & { label: "A" | "B" }>; result: TitleTestResult | null }

export async function planTitleTest(db: pg.Pool, a: { videoId: string; titleA: string; titleB: string; windowDays: number }): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const [ta, tb] = [a.titleA.trim(), a.titleB.trim()];
  if (ta.length < 5 || ta.length > 95 || tb.length < 5 || tb.length > 95 || ta === tb) return { ok: false, error: "Give two different titles of 5 to 95 characters: A (live now) and B." };
  if (!(a.windowDays >= 1 && a.windowDays <= 28)) return { ok: false, error: "Each window is 1 to 28 days." };
  if (!/^[0-9a-f-]{36}$/.test(a.videoId)) return { ok: false, error: "That video is not uploaded yet." };
  const up = await db.query("select 1 from uploads where video_id = $1::uuid and status = 'uploaded' limit 1", [a.videoId]);
  if (!up.rows[0]) return { ok: false, error: "That video is not uploaded yet." };
  const { rows } = await db.query<{ id: string }>("insert into title_experiments (video_id, title_a, title_b, window_days) values ($1, $2, $3, $4) returning id::text", [a.videoId, ta, tb, a.windowDays]);
  await recordAudit(db, "title_test.planned", { experimentId: rows[0]!.id, videoId: a.videoId });
  return { ok: true, id: rows[0]!.id };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Views in one window = the newest saved snapshot on or before the end day minus the one on or before the start day. */
export async function recordTitleWindow(db: pg.Pool, id: string, label: "A" | "B", startDay: string, endDay: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!DAY.test(startDay) || !DAY.test(endDay) || endDay <= startDay) return { ok: false, error: "Give a start day before the end day (YYYY-MM-DD)." };
  const ex = await db.query<{ video_id: string; phases: TitleExperiment["phases"] }>("select video_id, phases from title_experiments where id = $1::bigint", [id]);
  const e = ex.rows[0];
  if (!e) return { ok: false, error: "No such title test." };
  const snap = async (day: string) =>
    (await db.query<{ views: string | null }>("select views::text from video_analytics where video_id = $1 and day <= $2::date and error is null and views is not null order by day desc limit 1", [e.video_id, day])).rows[0];
  const [s, t] = [await snap(startDay), await snap(endDay)];
  if (!s || !t) return { ok: false, error: "There is no saved analytics snapshot on or before those days. Pull analytics first." };
  const days = (Date.parse(`${endDay}T00:00:00Z`) - Date.parse(`${startDay}T00:00:00Z`)) / 86_400_000;
  const views = Number(t.views) - Number(s.views);
  if (views < 0) return { ok: false, error: "Views went down between the snapshots, so this window cannot be used." };
  const phases = [...e.phases.filter((p) => p.label !== label), { label, views, days, avgViewPct: null }];
  const status = phases.length === 2 ? "measured" : "running";
  await db.query("update title_experiments set phases = $2::jsonb, status = $3 where id = $1::bigint and status <> 'concluded'", [id, JSON.stringify(phases), status]);
  await recordAudit(db, "title_test.window_recorded", { experimentId: id, label, views, days });
  return { ok: true };
}

/** The verdict is advice only: nothing is changed on YouTube. */
export async function evaluateTitleTest(db: pg.Pool, id: string): Promise<{ ok: true; result: TitleTestResult } | { ok: false; error: string }> {
  const ex = await db.query<{ phases: TitleExperiment["phases"] }>("select phases from title_experiments where id = $1::bigint", [id]);
  const e = ex.rows[0];
  const a = e?.phases.find((p) => p.label === "A");
  const b = e?.phases.find((p) => p.label === "B");
  if (!e || !a || !b) return { ok: false, error: "Record both windows first." };
  const result = concludeTitleTest(a, b);
  await db.query("update title_experiments set result = $2::jsonb, status = 'concluded' where id = $1::bigint", [id, JSON.stringify(result)]);
  await recordAudit(db, "title_test.concluded", { experimentId: id, verdict: result.verdict });
  return { ok: true, result };
}
