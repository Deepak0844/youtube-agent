import type pg from "pg";
import { YT_ID, releasedNow, beatSpans, channelSubsUrl, parseSubs, subsWindow, dropOff, isNoise, parseRetention, parseStats, parseTotals, retentionUrl, statsUrl, totalsUrl, type Curve, type Stats, type Totals } from "@/server/core/analytics";
import { safeReason } from "@/server/core/paid-call";
import { quotaDay } from "@/server/core/youtube-oauth";
import type { Keyring } from "@/server/core/vault-crypto";
import { recordAudit } from "./audit";
import { notifySafe } from "./notify";
import { getAccessToken, reserveQuota, type GoogleHttp } from "./youtube-channels";

// "Run now" analytics pull. Read-only against YouTube: videos.list (statistics) and the YouTube Analytics API. Every call goes
// through the injected GoogleHttp (safeFetch in production). The Data API call reserves quota first and honours the answer;
// the Analytics API has its own quota that this app does not count. Nothing is retried: a failed part is written to the
// snapshot as `error` and shown, and the owner may press Run now again (a snapshot without an error is never touched that day).

export type PullBy = { kind: "session"; sessionId: string } | { kind: "worker" };
export interface PullResult {
  pulled: number;
  failed: number;
  alreadyDone: number;
  quotaStopped: boolean;
  skipped: Array<{ channel: string; reason: string }>;
}

const SKIP_REASON = { needs_reconnect: "needs reconnecting (Settings, Channels)", unconfirmed: "not confirmed as yours yet (Settings, Channels)", unavailable: "could not sign in to Google" } as const;
const BATCH = 50;

interface Target { videoId: string; youtubeId: string; channelId: string; rowId: string | null; status: string | null; title: string | null; startDay: string }

async function json(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export async function pullAnalytics(db: pg.Pool, ring: Keyring | (() => Keyring), http: GoogleHttp, by: PullBy, opts: { now?: Date } = {}): Promise<PullResult> {
  const day = quotaDay(opts.now ?? new Date());
  const out: PullResult = { pulled: 0, failed: 0, alreadyDone: 0, quotaStopped: false, skipped: [] };
  const { rows } = await db.query<{ video_id: string; youtube_id: string; channel_id: string; row_id: string | null; status: string | null; title: string | null; start_day: string; done: boolean }>(
    `select distinct on (u.video_id) u.video_id, u.youtube_id, u.channel_id, c.id as row_id, c.status, c.title,
            (coalesce(u.finished_at, u.created_at)::date - 1)::text as start_day,
            exists (select 1 from video_analytics a where a.video_id = u.video_id and a.day = $1::date and a.error is null) as done
       from uploads u left join youtube_channels c on c.channel_id = u.channel_id
      where u.status = 'uploaded' and u.youtube_id is not null
      order by u.video_id, u.finished_at desc nulls last`,
    [day],
  );
  const byChannel = new Map<string, Target[]>();
  for (const r of rows) {
    if (!YT_ID.test(r.youtube_id)) continue;
    if (r.done) {
      out.alreadyDone++;
      continue;
    }
    const t: Target = { videoId: r.video_id, youtubeId: r.youtube_id, channelId: r.channel_id, rowId: r.row_id, status: r.status, title: r.title, startDay: r.start_day };
    byChannel.set(r.channel_id, [...(byChannel.get(r.channel_id) ?? []), t]);
  }

  for (const [channelId, targets] of byChannel) {
    const first = targets[0]!;
    const name = first.title ?? channelId;
    if (!first.rowId) {
      out.skipped.push({ channel: name, reason: "the channel is no longer connected" });
      continue;
    }
    const tok = await getAccessToken(db, ring, http, first.rowId);
    if (!tok.ok) {
      out.skipped.push({ channel: name, reason: SKIP_REASON[tok.reason] });
      continue;
    }
    const auth = { headers: { authorization: `Bearer ${tok.accessToken}` } };
    await pullChannelSubs(db, http, auth, channelId, day);
    for (let i = 0; i < targets.length && !out.quotaStopped; i += BATCH) {
      const batch = targets.slice(i, i + BATCH);
      if (!(await reserveQuota(db, "videos.list"))) {
        out.quotaStopped = true;
        break;
      }
      let stats = new Map<string, Stats>();
      let statsError: string | null = null;
      try {
        const res = await http(statsUrl(batch.map((t) => t.youtubeId)), auth);
        if (res.ok) stats = parseStats(await json(res));
        else statsError = `YouTube statistics answered ${res.status}`;
      } catch (e) {
        statsError = `YouTube statistics: ${safeReason(e)}`;
      }
      for (const t of batch) {
        const errors: string[] = statsError ? [statsError] : [];
        const s = stats.get(t.youtubeId) ?? null;
        if (!statsError && !s) errors.push("YouTube returned no statistics for this video (private, deleted or not processed yet)");
        let totals: Totals | null = null;
        let curve: Curve | null = null;
        try {
          const tr = await http(totalsUrl(t.youtubeId, t.startDay, day), auth);
          if (tr.ok) totals = parseTotals(await json(tr));
          else errors.push(`YouTube Analytics totals answered ${tr.status}`);
          const rr = await http(retentionUrl(t.youtubeId, t.startDay, day), auth);
          if (rr.ok) curve = parseRetention(await json(rr));
          else errors.push(`YouTube Analytics retention answered ${rr.status}`);
        } catch (e) {
          errors.push(`YouTube Analytics: ${safeReason(e)}`);
        }
        const error = errors.length ? errors.join("; ").slice(0, 500) : null;
        await db.query(
          `insert into video_analytics (video_id, youtube_id, day, views, likes, comments, analytics_views, minutes_watched, avg_view_pct, retention, error)
           values ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
           on conflict (video_id, day) do update set youtube_id = excluded.youtube_id, views = excluded.views, likes = excluded.likes, comments = excluded.comments,
             analytics_views = excluded.analytics_views, minutes_watched = excluded.minutes_watched, avg_view_pct = excluded.avg_view_pct,
             retention = excluded.retention, error = excluded.error, pulled_at = now()
             where video_analytics.error is not null`,
          [t.videoId, t.youtubeId, day, s?.views ?? null, s?.likes ?? null, s?.comments ?? null, totals?.views ?? null, totals?.minutesWatched ?? null, totals?.avgViewPct ?? null, curve ? JSON.stringify(curve) : null, error],
        );
        if (error) out.failed++;
        else out.pulled++;
        if (s?.privacy === "public") await releaseNotice(db, t.videoId, opts.now ?? new Date());
      }
    }
  }
  await recordAudit(db, "analytics.pulled", {
    by: by.kind, sessionId: by.kind === "session" ? by.sessionId : null,
    pulled: out.pulled, failed: out.failed, alreadyDone: out.alreadyDone, skippedChannels: out.skipped.length, quotaStopped: out.quotaStopped,
  });
  return out;
}

/** Subscribers gained and lost over the last week, one Analytics call per channel per day. Failure is written, never thrown. */
async function pullChannelSubs(db: pg.Pool, http: GoogleHttp, auth: { headers: Record<string, string> }, channelId: string, day: string): Promise<void> {
  const done = await db.query("select 1 from channel_analytics where channel_id = $1 and day = $2::date and error is null", [channelId, day]);
  if (done.rowCount) return;
  const w = subsWindow(day);
  let gained: number | null = null;
  let lost: number | null = null;
  let error: string | null = null;
  try {
    const res = await http(channelSubsUrl(w.start, w.end), auth);
    if (res.ok) ({ gained, lost } = parseSubs(await json(res)));
    else error = `YouTube Analytics subscribers answered ${res.status}`;
  } catch (e) {
    error = `YouTube Analytics subscribers: ${safeReason(e)}`.slice(0, 500);
  }
  await db.query(
    `insert into channel_analytics (channel_id, day, start_day, end_day, subscribers_gained, subscribers_lost, error)
     values ($1, $2::date, $3::date, $4::date, $5, $6, $7)
     on conflict (channel_id, day) do update set start_day = excluded.start_day, end_day = excluded.end_day, subscribers_gained = excluded.subscribers_gained,
       subscribers_lost = excluded.subscribers_lost, error = excluded.error, pulled_at = now()
       where channel_analytics.error is not null`,
    [channelId, day, w.start, w.end, gained, lost, error],
  );
}

/** "Scheduled release done", once per video (the notification's transition id), when a scheduled private video is now public. */
async function releaseNotice(db: pg.Pool, videoId: string, now: Date): Promise<void> {
  try {
    const meta = (await db.query<{ body: unknown }>("select body from video_content where video_id = $1 and kind = 'metadata' order by version desc limit 1", [videoId])).rows[0]?.body;
    if (!releasedNow(meta, "public", now.getTime())) return;
    await notifySafe(db, undefined, { event: "scheduled_release_done", videoId, from: "scheduled", to: "scheduled_release_done", transitionId: `release.${videoId}`, detail: "The scheduled video is public now." });
  } catch {
    // a notice is never worth failing the pull
  }
}

export function pullMessage(r: PullResult): string {
  const parts = [`Pulled ${r.pulled} video${r.pulled === 1 ? "" : "s"}`];
  if (r.alreadyDone) parts.push(`${r.alreadyDone} already done today`);
  if (r.failed) parts.push(`${r.failed} failed (see the error on each row; nothing is retried on its own)`);
  if (r.quotaStopped) parts.push("stopped: not enough YouTube quota left today");
  for (const s of r.skipped) parts.push(`skipped ${s.channel}: ${s.reason}`);
  return parts.join(". ") + ".";
}

export interface AnalyticsRow {
  videoId: string;
  topic: string;
  channelTitle: string | null;
  channelId: string | null;
  youtubeId: string;
  day: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  minutesWatched: number | null;
  avgViewPct: number | null;
  spendMicroUsd: number;
  pulledAtIst: string | null;
  error: string | null;
  retentionAt10: number | null;
  biggestDropBeat: string | null;
  biggestDrop: number | null;
  hasCurve: boolean;
}
export interface AnalyticsView {
  rows: AnalyticsRow[];
  shortsWithCurve: number;
  noise: boolean;
}

const n = (v: string | null): number | null => (v === null ? null : Number(v));

/** Every uploaded video with its newest snapshot, its spend so far, and its drop-off mapped to its beats. */
export async function loadAnalytics(db: Pick<pg.Pool, "query">): Promise<AnalyticsView> {
  const { rows } = await db.query<{
    video_id: string; topic: string; youtube_id: string; channel_title: string | null; channel_id: string | null; day: string | null; views: string | null; likes: string | null; comments: string | null;
    minutes: string | null; pct: string | null; retention: Curve | null; error: string | null; pulled_ist: string | null; spend: string;
  }>(
    `select u.video_id, v.topic, u.youtube_id, c.title as channel_title, u.channel_id, a.day::text as day, a.views::text as views, a.likes::text as likes, a.comments::text as comments,
            a.minutes_watched::text as minutes, a.avg_view_pct::text as pct, a.retention, a.error,
            to_char(a.pulled_at at time zone 'Asia/Kolkata', 'DD Mon YYYY, HH24:MI') as pulled_ist,
            coalesce((select sum(si.actual_micro_usd) from spend_intents si join stage_runs sr on sr.id = si.stage_run_id where sr.video_id = u.video_id and si.status = 'done'), 0)::text as spend
       from (select distinct on (video_id) video_id, youtube_id, channel_id from uploads where status = 'uploaded' and youtube_id is not null order by video_id, finished_at desc nulls last) u
       join videos v on v.id = u.video_id
       left join youtube_channels c on c.channel_id = u.channel_id
       left join lateral (select * from video_analytics x where x.video_id = u.video_id order by x.day desc limit 1) a on true
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
  let shortsWithCurve = 0;
  const out = rows.map((r): AnalyticsRow => {
    const curve = Array.isArray(r.retention) ? r.retention : [];
    const beats = (body(r.video_id, "beats") as { beats?: unknown } | undefined)?.beats;
    const d = dropOff(curve, beatSpans(beats, body(r.video_id, "scenes")));
    if (curve.length > 0) shortsWithCurve++;
    return {
      videoId: r.video_id, topic: r.topic, channelTitle: r.channel_title, channelId: r.channel_id, youtubeId: r.youtube_id, day: r.day, views: n(r.views), likes: n(r.likes), comments: n(r.comments),
      minutesWatched: n(r.minutes), avgViewPct: n(r.pct), spendMicroUsd: Number(r.spend), pulledAtIst: r.pulled_ist, error: r.error,
      retentionAt10: d.retentionAt10, biggestDropBeat: d.biggestDropBeat, biggestDrop: d.biggestDrop, hasCurve: curve.length > 0,
    };
  });
  return { rows: out, shortsWithCurve, noise: isNoise(shortsWithCurve) };
}
