import type pg from "pg";
import { MAX_IDEAS_PER_RUN, RESEARCH_CAP_USD, parseResearchIdeas, researchPrompt } from "@/server/core/idea-research";
import { learningNotes } from "@/server/core/insights";
import { outliers as findOutliers } from "@/server/core/research";
import { recordAudit } from "./audit";
import { addResearchIdea } from "./ideas";
import { loadInsightShorts, ModelUnavailable, type By, type InsightsModel } from "./insights";

// The idea researcher (Phase 6.4): ONE capped text-model call over data we already hold (our topics, learning notes, competitor
// outliers, trend titles). It browses nothing and fetches nothing, so there is no outbound request to guard. The reply is parsed as data
// and each idea goes through the normal ideas door as 'proposed'. Nothing here drafts, approves or uploads.
// One run at a time across the web app and the worker: a database advisory lock, taken before anything is read or sent.

const LOCK_KEY = 6_040_001; // arbitrary fixed id for "idea research is running"
const micro = (usd: number) => Math.round(usd * 1_000_000);

export interface ResearchResult { added: number; costMicroUsd: number; message: string }

/** Scheduler inputs, by the database clock. */
export async function researchState(db: Pick<pg.Pool, "query">, istDate: string): Promise<{ backlog: number; hoursSinceLastRun: number | null; runsToday: number }> {
  const { rows } = await db.query<{ backlog: string; hours: string | null; today: string }>(
    `select (select count(*) from ideas where status = 'proposed')::text as backlog,
            (select (extract(epoch from now() - max(started_at)) / 3600)::text from schedule_runs where job = 'research') as hours,
            (select count(*) from schedule_runs where job = 'research' and run_key like $1)::text as today`,
    [`${istDate}.%`],
  );
  const r = rows[0]!;
  return { backlog: Number(r.backlog), hoursSinceLastRun: r.hours === null ? null : Number(r.hours), runsToday: Number(r.today) };
}

async function context(db: pg.Pool, now: Date) {
  const [known, vids, trends, shorts] = await Promise.all([
    db.query<{ topic: string }>("select topic from (select topic, created_at from ideas union all select topic, created_at from videos) t order by created_at desc"),
    db.query<{ video_id: string; competitor_id: string; title: string; published_at: Date | null; views: string }>("select video_id, competitor_id, title, published_at, views::text from research_videos"),
    db.query<{ topic: string; url: string }>("select topic, url from research_trends order by signal desc limit 15"),
    loadInsightShorts(db),
  ]);
  const seen = new Set<string>();
  const outliers = findOutliers(vids.rows.map((r) => ({ videoId: r.video_id, competitorId: r.competitor_id, title: r.title, publishedAt: r.published_at, views: Number(r.views) })), now)
    .filter((o) => !seen.has(o.title) && !!seen.add(o.title));
  return { known: known.rows.map((r) => r.topic), outliers, trends: trends.rows, notes: learningNotes(shorts) };
}

/**
 * Never throws for "no model", "unpriced", "spend limit" or "already running": it returns a message with added = 0 (the scheduler logs it as ok).
 * Other failures throw, so the scheduler records run_failed.
 */
export async function runIdeaResearch(db: pg.Pool, model: InsightsModel, by: By, opts: { now?: Date } = {}): Promise<ResearchResult> {
  const now = opts.now ?? new Date();
  const none = (message: string): ResearchResult => ({ added: 0, costMicroUsd: 0, message });
  const lock = await db.connect();
  let unlocked = false;
  try {
    if (!(await lock.query<{ ok: boolean }>("select pg_try_advisory_lock($1) as ok", [LOCK_KEY])).rows[0]!.ok) return none("skipped: a research run is already going");
    const c = await context(db, now);
    // One attempt per period: the counter makes the period new after each run that was audited, so a second run the same day pays again,
    // but a run that started and never finished is not repeated (the model door refuses the same period).
    const day = now.toISOString().slice(0, 10);
    const { rows } = await db.query<{ n: string }>("select count(*)::text as n from audit_log where event = 'ideas.researched' and at >= $1::date", [day]);
    const period = `${day}.${Number(rows[0]!.n) + 1}`;
    let out: { text: string; costUsd: number };
    try {
      out = await model.run({ kind: "research", period, prompt: researchPrompt({ existing: c.known, notes: c.notes, outliers: c.outliers, trends: c.trends }), maxUsd: RESEARCH_CAP_USD });
    } catch (e) {
      if (e instanceof ModelUnavailable) return none(`skipped: ${e.message}`);
      throw e;
    }
    const cost = micro(Number.isFinite(out.costUsd) && out.costUsd > 0 ? out.costUsd : 0);
    const overCap = cost > micro(RESEARCH_CAP_USD);
    const ideas = overCap ? [] : parseResearchIdeas(out.text, c.known, c.trends.map((t) => t.url));
    let added = 0;
    for (const i of ideas.slice(0, MAX_IDEAS_PER_RUN)) if ((await addResearchIdea(db, i, by.kind === "session" ? by.sessionId : null)).ok) added++;
    await recordAudit(db, "ideas.researched", { by: by.kind, sessionId: by.kind === "session" ? by.sessionId : null, added, costMicroUsd: cost, overCap });
    return { added, costMicroUsd: cost, message: overCap ? "the model call cost more than the cap, so its ideas were dropped" : `${added} idea${added === 1 ? "" : "s"} added` };
  } finally {
    unlocked = await lock.query("select pg_advisory_unlock($1)", [LOCK_KEY]).then(() => true, () => false);
    lock.release(!unlocked); // a connection that may still hold the lock is destroyed, not reused
  }
}
