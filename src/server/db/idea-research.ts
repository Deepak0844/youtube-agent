import type pg from "pg";
import { channelDue, channelLang, MAX_IDEAS_PER_RUN, RESEARCH_CAP_USD, parseResearchIdeas, researchPrompt, type ChannelResearchState } from "@/server/core/idea-research";
import { learningNotes } from "@/server/core/insights";
import { outliers as findOutliers } from "@/server/core/research";
import { recordAudit } from "./audit";
import { addResearchIdea } from "./ideas";
import { loadInsightShorts, ModelUnavailable, type By, type InsightsModel } from "./insights";

// The idea researcher (Phase 6.4), once per CONNECTED channel: one capped text-model call per channel over data we already hold (that
// channel's title, language, description and recent videos, its own watched competitors' outliers, shared trend titles, our learning
// notes). It browses nothing and fetches nothing except, at most, the channel's description (read only, quota guarded, failure is
// not fatal). The reply is parsed as data and each idea goes through the normal ideas door as 'proposed' for that channel. Nothing
// here drafts, approves or uploads. One run at a time across the web app and the worker: a database advisory lock.

const LOCK_KEY = 6_040_001; // arbitrary fixed id for "idea research is running"
const micro = (usd: number) => Math.round(usd * 1_000_000);

export interface ResearchResult { added: number; costMicroUsd: number; message: string }

interface ChannelRow extends ChannelResearchState {
  id: string;
  channelId: string;
  title: string;
  language: string;
  description: string;
  descriptionStale: boolean;
}

/** The connected channels with their own backlog and hours since their last research, by the database clock. */
async function connectedChannels(db: Pick<pg.Pool, "query">): Promise<ChannelRow[]> {
  const { rows } = await db.query<{ id: string; channel_id: string; title: string; default_language: string; description: string; stale: boolean; backlog: string; hours: string | null }>(
    `select c.id, c.channel_id, c.title, c.default_language, c.description,
            (c.description = '' or c.description_fetched_at is null or c.description_fetched_at < now() - interval '7 days') as stale,
            (select count(*) from ideas i where i.channel_id = c.channel_id and i.status = 'proposed')::text as backlog,
            (select (extract(epoch from now() - max(a.at)) / 3600)::text from audit_log a where a.event = 'ideas.researched' and a.detail->>'channelId' = c.channel_id) as hours
       from youtube_channels c where c.status = 'connected' order by c.created_at, c.id`,
  );
  return rows.map((r) => ({
    id: r.id, channelId: r.channel_id, title: r.title, language: r.default_language, description: r.description, descriptionStale: r.stale,
    backlog: Number(r.backlog), hoursSinceResearch: r.hours === null ? null : Number(r.hours),
  }));
}

/** Scheduler inputs, by the database clock. */
export async function researchState(db: Pick<pg.Pool, "query">, istDate: string): Promise<{ hoursSinceLastRun: number | null; runsToday: number; channels: ChannelResearchState[] }> {
  const { rows } = await db.query<{ hours: string | null; today: string }>(
    `select (select (extract(epoch from now() - max(started_at)) / 3600)::text from schedule_runs where job = 'research') as hours,
            (select count(*) from schedule_runs where job = 'research' and run_key like $1)::text as today`,
    [`${istDate}.%`],
  );
  const r = rows[0]!;
  return { hoursSinceLastRun: r.hours === null ? null : Number(r.hours), runsToday: Number(r.today), channels: await connectedChannels(db) };
}

async function context(db: pg.Pool, now: Date, ch: ChannelRow) {
  const [known, own, recent, vids, trends, shorts] = await Promise.all([
    db.query<{ topic: string }>("select topic from (select topic, created_at from ideas union all select topic, created_at from videos) t order by created_at desc"),
    db.query<{ topic: string }>("select topic from (select topic, created_at from ideas where channel_id = $1 union all select topic, created_at from videos where channel_id = $1) t order by created_at desc", [ch.channelId]),
    db.query<{ topic: string }>("select topic from videos where channel_id = $1 order by created_at desc limit 20", [ch.channelId]),
    db.query<{ video_id: string; competitor_id: string; title: string; published_at: Date | null; views: string }>("select video_id, competitor_id, title, published_at, views::text from research_videos where owner_channel_id = $1", [ch.channelId]),
    db.query<{ topic: string; url: string }>("select topic, url from research_trends order by signal desc limit 15"),
    loadInsightShorts(db),
  ]);
  const seen = new Set<string>();
  const outliers = findOutliers(vids.rows.map((r) => ({ videoId: r.video_id, competitorId: r.competitor_id, title: r.title, publishedAt: r.published_at, views: Number(r.views) })), now)
    .filter((o) => !seen.has(o.title) && !!seen.add(o.title));
  return { known: known.rows.map((r) => r.topic), own: own.rows.map((r) => r.topic), recent: recent.rows.map((r) => r.topic), outliers, trends: trends.rows, notes: learningNotes(shorts) };
}

export interface ResearchOptions {
  now?: Date;
  /** Research only this channel (the owner chose it): skips the backlog and 20 hour checks, never the cap or the one-attempt rule. */
  channelId?: string;
  /** Reads a stale or empty channel description (by channel row id). Failures are ignored: research goes on without it. */
  refreshDescription?: (rowId: string) => Promise<unknown>;
}

/**
 * Never throws for "no model", "unpriced", "spend limit" or "already running": it returns a message with added = 0 (the scheduler logs it as ok).
 * A refused model or a spend limit ends the whole run (no further channel is tried). Other failures throw, so the scheduler records run_failed.
 */
export async function runIdeaResearch(db: pg.Pool, model: InsightsModel, by: By, opts: ResearchOptions = {}): Promise<ResearchResult> {
  const now = opts.now ?? new Date();
  const none = (message: string): ResearchResult => ({ added: 0, costMicroUsd: 0, message });
  const lock = await db.connect();
  let unlocked = false;
  try {
    if (!(await lock.query<{ ok: boolean }>("select pg_try_advisory_lock($1) as ok", [LOCK_KEY])).rows[0]!.ok) return none("skipped: a research run is already going");
    const all = await connectedChannels(db);
    const picked = opts.channelId ? all.filter((c) => c.channelId === opts.channelId) : all.filter(channelDue);
    if (picked.length === 0) return none(opts.channelId ? "skipped: that channel is not connected" : "skipped: no connected channel needs ideas right now");
    const day = now.toISOString().slice(0, 10);
    let added = 0;
    let cost = 0;
    let done = 0;
    let stopped = "";
    let capHit = false;
    for (let ch of picked) {
      if (opts.refreshDescription && ch.descriptionStale) {
        try {
          await opts.refreshDescription(ch.id);
          ch = (await connectedChannels(db)).find((c) => c.id === ch.id) ?? ch;
        } catch {
          // not fatal: research goes on with what we have (or without a description)
        }
      }
      const c = await context(db, now, ch);
      // One attempt per channel and period: the counter makes the period new after each audited run, so a second run the same day pays
      // again, but a run that started and never finished is not repeated (the model door refuses the same period).
      const { rows } = await db.query<{ n: string }>("select count(*)::text as n from audit_log where event = 'ideas.researched' and detail->>'channelId' = $1 and at >= $2::date", [ch.channelId, day]);
      const period = `${day}.${Number(rows[0]!.n) + 1}.${ch.channelId}`;
      let out: { text: string; costUsd: number };
      try {
        out = await model.run({
          kind: "research", period, maxUsd: RESEARCH_CAP_USD,
          prompt: researchPrompt({ channel: { title: ch.title, language: channelLang(ch.language), description: ch.description }, existing: c.own, recentTitles: c.recent, notes: c.notes, outliers: c.outliers, trends: c.trends }),
        });
      } catch (e) {
        if (!(e instanceof ModelUnavailable)) throw e;
        if (/already started/.test(e.message)) continue; // this channel and period only
        stopped = e.message;
        break;
      }
      const spent = micro(Number.isFinite(out.costUsd) && out.costUsd > 0 ? out.costUsd : 0);
      const overCap = spent > micro(RESEARCH_CAP_USD);
      const ideas = overCap ? [] : parseResearchIdeas(out.text, c.known, c.trends.map((t) => t.url));
      let n = 0;
      for (const i of ideas.slice(0, MAX_IDEAS_PER_RUN)) if ((await addResearchIdea(db, i, by.kind === "session" ? by.sessionId : null, ch.channelId)).ok) n++;
      await recordAudit(db, "ideas.researched", { by: by.kind, sessionId: by.kind === "session" ? by.sessionId : null, channelId: ch.channelId, added: n, costMicroUsd: spent, overCap });
      capHit ||= overCap;
      added += n;
      cost += spent;
      done++;
    }
    if (done === 0 && stopped) return none(`skipped: ${stopped}`);
    const base = `${added} idea${added === 1 ? "" : "s"} added across ${done} channel${done === 1 ? "" : "s"}`;
    const notes = [capHit && "a model call cost more than the cap, so its ideas were dropped", stopped && `stopped: ${stopped}`].filter(Boolean);
    return { added, costMicroUsd: cost, message: notes.length ? `${base}; ${notes.join("; ")}` : base };
  } finally {
    unlocked = await lock.query("select pg_advisory_unlock($1)", [LOCK_KEY]).then(() => true, () => false);
    lock.release(!unlocked); // a connection that may still hold the lock is destroyed, not reused
  }
}
