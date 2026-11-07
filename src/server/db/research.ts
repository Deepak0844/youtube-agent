import type pg from "pg";
import {
  HN_TOP_URL, MIN_SCORE, RETENTION_DAYS, SEARCH_DAILY_MAX, SEARCH_DAILY_SHOWN, hnItemUrl, outliers as findOutliers, parseChannelRef, parseChannels, parseHnItem, parseHnTopIds,
  parsePlaylistVideoIds, parseSearchChannelIds, parseVideos, parseWikimediaTop, profileFrom, queriesFrom, scoreCandidate, uploadsPlaylistId, wikimediaUrl, words,
  type ChannelInfo, type Outlier, type TrendItem, type VideoInfo,
} from "@/server/core/research";
import { safeReason } from "@/server/core/paid-call";
import type { Keyring } from "@/server/core/vault-crypto";
import type { QuotaCall } from "@/server/core/youtube-oauth";
import { recordAudit } from "./audit";
import { getAccessToken, reserveQuota, type GoogleHttp } from "./youtube-channels";

// Competitor research (Phase 6 piece 6.4). Read-only against YouTube Data API v3 (channels, playlistItems, videos, search) with the
// owner's own login; trend lists from Hacker News and Wikimedia (no Reddit). Every outbound call goes through the injected http
// (safeFetch in production) and every answer is parsed as untrusted data. Each YouTube call reserves quota first; each search.list
// also counts against the app's own cap of 90 a day (research_searches, per UTC day). Nothing here writes to YouTube or to ideas.

type Ring = Keyring | (() => Keyring);
export type ResearchBy = { kind: "session"; sessionId: string } | { kind: "worker" };
const who = (by: ResearchBy) => ({ by: by.kind, sessionId: by.kind === "session" ? by.sessionId : null });
const utcDay = (now: Date): string => now.toISOString().slice(0, 10);
const BATCH = 50;
const CANDIDATE_LOOKUPS = 15; // channels scored per find run: each costs about 2 quota units
const FETCH_HEADERS = { "user-agent": "yt-studio/1.0 (personal research tool)", accept: "application/json" };

class Stop extends Error {}
export type Failure = { ok: false; reason: string };

// ---- search counter ----
export async function searchesToday(db: Pick<pg.Pool, "query">, now: Date = new Date()): Promise<number> {
  const { rows } = await db.query<{ n: number }>("select n from research_searches where day = $1::date", [utcDay(now)]);
  return rows[0]?.n ?? 0;
}

/** Counts one search.list call for today, atomically; false (and nothing counted) once the day is at the cap. */
export async function reserveSearch(db: Pick<pg.Pool, "query">, now: Date = new Date()): Promise<boolean> {
  const r = await db.query(
    `insert into research_searches (day, n) values ($1::date, 1)
     on conflict (day) do update set n = research_searches.n + 1 where research_searches.n < $2 returning n`,
    [utcDay(now), SEARCH_DAILY_MAX],
  );
  return (r.rowCount ?? 0) > 0;
}

// ---- YouTube calls ----
const YT = "https://www.googleapis.com/youtube/v3";
const q = (o: Record<string, string>) => new URLSearchParams(o).toString();

interface Api { db: pg.Pool; http: GoogleHttp; auth: RequestInit; now: Date }
async function yt(api: Api, call: QuotaCall, path: string, params: Record<string, string>): Promise<unknown> {
  if (!(await reserveQuota(api.db, call, { now: api.now }))) throw new Stop("not enough YouTube quota left today");
  const res = await api.http(`${YT}/${path}?${q(params)}`, api.auth);
  if (!res.ok) throw new Error(`YouTube answered ${res.status}`);
  return res.json();
}

async function videosByIds(api: Api, ids: string[]): Promise<VideoInfo[]> {
  const out: VideoInfo[] = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    out.push(...parseVideos(await yt(api, "videos.list", "videos", { part: "snippet,statistics,contentDetails", id: ids.slice(i, i + BATCH).join(",") })));
  }
  return out;
}
async function recentUploads(api: Api, channelId: string, n: number): Promise<VideoInfo[]> {
  const playlistId = uploadsPlaylistId(channelId);
  if (!playlistId) return [];
  const ids = parsePlaylistVideoIds(await yt(api, "playlistItems.list", "playlistItems", { part: "contentDetails", playlistId, maxResults: String(n) }));
  return ids.length ? videosByIds(api, ids) : [];
}
async function channelStats(api: Api, ids: string[]): Promise<ChannelInfo[]> {
  const out: ChannelInfo[] = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    out.push(...parseChannels(await yt(api, "channels.list", "channels", { part: "snippet,statistics", id: ids.slice(i, i + BATCH).join(",") })));
  }
  return out;
}

interface Owner { rowId: string; channelId: string; language: string; title: string }
async function openApi(db: pg.Pool, ring: Ring, http: GoogleHttp, rowId: string, now: Date): Promise<{ api: Api; owner: Owner } | Failure> {
  const { rows } = await db.query<{ channel_id: string; default_language: string; title: string }>("select channel_id, default_language, title from youtube_channels where id = $1", [rowId]);
  const c = rows[0];
  if (!c) return { ok: false, reason: "That channel is not connected." };
  const tok = await getAccessToken(db, ring, http, rowId);
  if (!tok.ok) return { ok: false, reason: tok.reason === "unavailable" ? "Could not sign in to Google." : "This channel needs to be confirmed or reconnected first (Settings, Channels)." };
  return { api: { db, http, auth: { headers: { authorization: `Bearer ${tok.accessToken}` } }, now }, owner: { rowId, channelId: c.channel_id, language: c.default_language.split("-")[0] || "en", title: c.title } };
}
const failure = (e: unknown): Failure => ({ ok: false, reason: e instanceof Stop ? e.message : `YouTube research failed (${safeReason(e)}).` });

// ---- find competitors ----
export type DiscoverResult = { ok: true; added: number; searches: number; stopped: boolean } | Failure;

export async function discoverCompetitors(db: pg.Pool, ring: Ring, http: GoogleHttp, rowId: string, by: ResearchBy, opts: { now?: Date } = {}): Promise<DiscoverResult> {
  const now = opts.now ?? new Date();
  const opened = await openApi(db, ring, http, rowId, now);
  if ("ok" in opened) return opened;
  const { api, owner } = opened;
  let searches = 0;
  let stopped = false;
  let added = 0;
  try {
    const mine = await recentUploads(api, owner.channelId, 15);
    const profile = profileFrom(mine, owner.language);
    if (profile.keywords.length === 0) return { ok: false, reason: "This channel has no uploads to learn from yet." };
    const queries = queriesFrom(profile);
    // the search phrases describe the niche better than a few titles' leftovers, so their words count as topic keywords too
    const scoring = { ...profile, keywords: [...new Set([...profile.keywords, ...queries.flatMap(words)])] };
    const ids: string[] = [];
    for (const query of queries) {
      if (!(await reserveSearch(db, now))) {
        stopped = true;
        break;
      }
      searches++;
      ids.push(...parseSearchChannelIds(await yt(api, "search.list", "search", { part: "snippet", type: "channel", q: query, maxResults: "8" })));
    }
    const { rows: known } = await db.query<{ competitor_id: string }>(
      "select competitor_id from research_candidates where owner_channel_id = $1 union select competitor_id from research_watch where owner_channel_id = $1",
      [owner.channelId],
    );
    const seen = new Set([owner.channelId, ...known.map((k) => k.competitor_id)]);
    const fresh = [...new Set(ids)].filter((i) => !seen.has(i)).slice(0, CANDIDATE_LOOKUPS);
    if (fresh.length > 0) {
      const stats = await channelStats(api, [...fresh, owner.channelId]);
      const ownSubs = stats.find((s) => s.id === owner.channelId)?.subs ?? 0;
      const scored: Array<{ c: ChannelInfo; score: number; reason: string }> = [];
      for (const c of stats.filter((s) => s.id !== owner.channelId)) {
        scored.push({ c, ...scoreCandidate(c, scoring, ownSubs, await recentUploads(api, c.id, 10), now) });
      }
      for (const s of scored.filter((x) => x.score >= MIN_SCORE).sort((a, b) => b.score - a.score).slice(0, 10)) {
        const r = await db.query(
          `insert into research_candidates (owner_channel_id, competitor_id, title, score, reason, subs) values ($1, $2, $3, $4, $5, $6) on conflict do nothing`,
          [owner.channelId, s.c.id, s.c.title, s.score, s.reason.slice(0, 500), s.c.subs],
        );
        added += r.rowCount ?? 0;
      }
    }
  } catch (e) {
    if (!(e instanceof Stop)) return failure(e);
    stopped = true;
  }
  await recordAudit(db, "research.discovered", { ...who(by), ownerChannelId: owner.channelId, added, searches, searchesToday: await searchesToday(db, now), stopped });
  return { ok: true, added, searches, stopped };
}

// ---- suggestions: Watch / Not relevant, add by handle ----
export async function decideCandidate(db: pg.Pool, ownerChannelId: string, competitorId: string, decision: "watch" | "reject", sessionId: string): Promise<boolean> {
  const c = await db.connect();
  try {
    await c.query("begin");
    const r = await c.query<{ title: string }>(
      "update research_candidates set status = $3, refreshed_at = now() where owner_channel_id = $1 and competitor_id = $2 and status = 'suggested' returning title",
      [ownerChannelId, competitorId, decision === "watch" ? "watching" : "rejected"],
    );
    if (r.rows[0] && decision === "watch") {
      await c.query("insert into research_watch (owner_channel_id, competitor_id, title) values ($1, $2, $3) on conflict (owner_channel_id, competitor_id) do nothing", [ownerChannelId, competitorId, r.rows[0].title]);
    }
    await c.query("commit");
    if (!r.rows[0]) return false;
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
  await recordAudit(db, "research.decided", { ownerChannelId, competitorId, decision, sessionId });
  return true;
}

export type AddResult = { ok: true; title: string } | Failure;
export async function addByHandle(db: pg.Pool, ring: Ring, http: GoogleHttp, rowId: string, ref: string, sessionId: string, opts: { now?: Date } = {}): Promise<AddResult> {
  const parsed = parseChannelRef(ref);
  if (!parsed) return { ok: false, reason: "Give a channel id (starts with UC) or a handle that starts with @." };
  const opened = await openApi(db, ring, http, rowId, opts.now ?? new Date());
  if ("ok" in opened) return opened;
  const { api, owner } = opened;
  let found: ChannelInfo | undefined;
  try {
    const params: Record<string, string> = parsed.kind === "id" ? { part: "snippet,statistics", id: parsed.id } : { part: "snippet,statistics", forHandle: parsed.handle };
    found = parseChannels(await yt(api, "channels.list", "channels", params))[0];
  } catch (e) {
    return failure(e);
  }
  if (!found) return { ok: false, reason: "That channel was not found." };
  if (found.id === owner.channelId) return { ok: false, reason: "That is your own channel." };
  await db.query(
    "insert into research_watch (owner_channel_id, competitor_id, title, added_by) values ($1, $2, $3, 'owner-handle') on conflict (owner_channel_id, competitor_id) do update set refreshed_at = now()",
    [owner.channelId, found.id, found.title],
  );
  await db.query("update research_candidates set status = 'watching' where owner_channel_id = $1 and competitor_id = $2", [owner.channelId, found.id]);
  await recordAudit(db, "research.added", { ownerChannelId: owner.channelId, competitorId: found.id, sessionId });
  return { ok: true, title: found.title };
}

// ---- refresh and mine ----
export type RefreshResult = { ok: true; channels: number; videos: number; stopped: boolean } | Failure;
export async function refreshWatched(db: pg.Pool, ring: Ring, http: GoogleHttp, rowId: string, by: ResearchBy, opts: { now?: Date } = {}): Promise<RefreshResult> {
  const opened = await openApi(db, ring, http, rowId, opts.now ?? new Date());
  if ("ok" in opened) return opened;
  const { api, owner } = opened;
  const { rows: watched } = await db.query<{ competitor_id: string }>("select competitor_id from research_watch where owner_channel_id = $1 order by added_at", [owner.channelId]);
  let channels = 0;
  let videos = 0;
  let stopped = false;
  try {
    for (const w of watched) {
      for (const v of await recentUploads(api, w.competitor_id, 15)) {
        if (v.channelId !== w.competitor_id) continue; // an answer about another channel is not stored under this one
        await db.query(
          `insert into research_videos (owner_channel_id, competitor_id, video_id, title, published_at, views, duration_s) values ($1, $2, $3, $4, $5, $6, $7)
           on conflict (owner_channel_id, video_id) do update set title = excluded.title, views = excluded.views, duration_s = excluded.duration_s, refreshed_at = now()`,
          [owner.channelId, w.competitor_id, v.videoId, v.title, v.publishedAt, v.views, v.durationS],
        );
        videos++;
      }
      await db.query("update research_watch set refreshed_at = now() where owner_channel_id = $1 and competitor_id = $2", [owner.channelId, w.competitor_id]);
      channels++;
    }
  } catch (e) {
    if (!(e instanceof Stop)) return failure(e);
    stopped = true;
  }
  await recordAudit(db, "research.refreshed", { ...who(by), ownerChannelId: owner.channelId, channels, videos, stopped });
  return { ok: true, channels, videos, stopped };
}

// ---- trends: Hacker News and Wikimedia only ----
export interface TrendResult { hackernews: number; wikimedia: number; failed: string[] }
const HN_N = 15;
const WIKI_N = 15;

async function getJson(http: GoogleHttp, url: string): Promise<unknown> {
  const res = await http(url, { headers: FETCH_HEADERS });
  if (!res.ok) throw new Error(`answered ${res.status}`);
  return res.json();
}

export async function refreshTrends(db: pg.Pool, http: GoogleHttp, by: ResearchBy, opts: { now?: Date } = {}): Promise<TrendResult> {
  const now = opts.now ?? new Date();
  const out: TrendResult = { hackernews: 0, wikimedia: 0, failed: [] };
  const sources: Array<[TrendItem["source"], () => Promise<TrendItem[]>]> = [
    ["hackernews", async () => {
      const ids = parseHnTopIds(await getJson(http, HN_TOP_URL), HN_N);
      const items: TrendItem[] = [];
      for (const id of ids) {
        const it = parseHnItem(await getJson(http, hnItemUrl(id)), id);
        if (it) items.push(it);
      }
      return items;
    }],
    ["wikimedia", async () => parseWikimediaTop(await getJson(http, wikimediaUrl(now)), WIKI_N)],
  ];
  for (const [source, load] of sources) {
    try {
      const items = await load();
      if (items.length === 0) throw new Error("no items");
      const stamp = new Date();
      for (const t of items) {
        await db.query(
          `insert into research_trends (source, item_key, topic, signal, url, refreshed_at) values ($1, $2, $3, $4, $5, $6)
           on conflict (source, item_key) do update set topic = excluded.topic, signal = excluded.signal, url = excluded.url, refreshed_at = excluded.refreshed_at`,
          [t.source, t.itemKey, t.topic, t.signal, t.url, stamp],
        );
      }
      await db.query("delete from research_trends where source = $1 and refreshed_at <> $2", [source, stamp]); // the list is today's list
      out[source] = items.length;
    } catch {
      out.failed.push(source);
    }
  }
  await recordAudit(db, "research.trends", { ...who(by), hackernews: out.hackernews, wikimedia: out.wikimedia, failed: out.failed });
  return out;
}

// ---- 30 day refresh-or-delete ----
export interface PurgeResult { candidates: number; watch: number; videos: number; trends: number }
export async function purgeStaleResearch(db: pg.Pool): Promise<PurgeResult> {
  const del = async (table: string): Promise<number> =>
    (await db.query(`delete from ${table} where refreshed_at < now() - ($1::int * interval '1 day')`, [RETENTION_DAYS])).rowCount ?? 0; // table names are constants below
  const out: PurgeResult = { candidates: await del("research_candidates"), watch: await del("research_watch"), videos: await del("research_videos"), trends: await del("research_trends") };
  if (out.candidates + out.watch + out.videos + out.trends > 0) await recordAudit(db, "research.purged", { ...out });
  return out;
}

/** Worker hook: at most one purge every few hours in this process; errors never reach the worker loop. */
export function throttledResearchPurge(db: pg.Pool, everyMs = 6 * 3600_000): () => Promise<void> {
  let last = 0;
  return async () => {
    const t = Date.now();
    if (t - last < everyMs) return;
    last = t;
    try {
      await purgeStaleResearch(db);
    } catch {
      // never reaches the worker loop
    }
  };
}

// ---- the daily job ----
const IST_OFFSET_MS = 5.5 * 3600_000;

/** Every connected channel: find competitors (when nothing is watched yet, and on Mondays), refresh and mine; then trends; then purge. */
export async function runCompetitorsJob(db: pg.Pool, ring: Ring, http: GoogleHttp, now: Date = new Date()): Promise<string> {
  const { rows: chans } = await db.query<{ id: string; channel_id: string; title: string }>("select id, channel_id, title from youtube_channels where status = 'connected' order by created_at, id");
  const monday = new Date(now.getTime() + IST_OFFSET_MS).getUTCDay() === 1;
  const by: ResearchBy = { kind: "worker" };
  const parts: string[] = [];
  let failed = 0;
  for (const c of chans) {
    try {
      let line = "";
      const { rows } = await db.query("select 1 from research_watch where owner_channel_id = $1 limit 1", [c.channel_id]);
      if (monday || rows.length === 0) {
        const d = await discoverCompetitors(db, ring, http, c.id, by, { now });
        if (!d.ok) throw new Error(d.reason);
        line += `${d.added} suggestion${d.added === 1 ? "" : "s"}`;
      }
      const r = await refreshWatched(db, ring, http, c.id, by, { now });
      if (!r.ok) throw new Error(r.reason);
      parts.push(`${c.title || c.channel_id}: ${[line, `${r.videos} video${r.videos === 1 ? "" : "s"} refreshed`].filter(Boolean).join(", ")}`);
    } catch {
      failed++; // one channel's problem (quota, expired login) must not stop the others
    }
  }
  const t = await refreshTrends(db, http, by, { now });
  await purgeStaleResearch(db);
  if (chans.length > 0 && failed === chans.length) throw new Error("every channel failed");
  if (chans.length === 0) parts.push("no connected channel");
  if (failed) parts.push(`${failed} channel(s) failed`);
  parts.push(`trends: ${t.hackernews} Hacker News, ${t.wikimedia} Wikimedia${t.failed.length ? ` (${t.failed.join(", ")} unavailable)` : ""}`);
  return parts.join(". ");
}

// ---- the page ----
export interface ResearchView {
  channels: Array<{ id: string; channelId: string; title: string }>;
  searchesToday: number;
  searchLimit: number;
  searchStop: number;
  suggestions: Array<{ competitorId: string; title: string; score: number; reason: string; subs: number }>;
  watching: Array<{ competitorId: string; title: string; videos: number; refreshedAtIst: string }>;
  outliers: Array<Outlier & { channel: string }>;
  trends: { hackernews: Array<{ topic: string; signal: number; url: string }>; wikimedia: Array<{ topic: string; signal: number; url: string }> };
}

export async function loadResearch(db: Pick<pg.Pool, "query">, ownerChannelId: string | null, now: Date = new Date()): Promise<ResearchView> {
  const owner = ownerChannelId ?? "";
  const [chans, used, sug, watch, vids, trends] = await Promise.all([
    db.query<{ id: string; channel_id: string; title: string }>("select id, channel_id, title from youtube_channels where status = 'connected' order by created_at, id"),
    searchesToday(db, now),
    db.query<{ competitor_id: string; title: string; score: string; reason: string; subs: string }>(
      "select competitor_id, title, score::text, reason, subs::text from research_candidates where owner_channel_id = $1 and status = 'suggested' order by score desc, found_at desc limit 50", [owner]),
    db.query<{ competitor_id: string; title: string; videos: string; ist: string }>(
      `select w.competitor_id, w.title, (select count(*) from research_videos v where v.owner_channel_id = w.owner_channel_id and v.competitor_id = w.competitor_id)::text as videos,
              to_char(w.refreshed_at at time zone 'Asia/Kolkata', 'DD Mon YYYY, HH24:MI') as ist
         from research_watch w where w.owner_channel_id = $1 order by w.added_at`, [owner]),
    db.query<{ video_id: string; competitor_id: string; title: string; published_at: Date | null; views: string }>(
      "select video_id, competitor_id, title, published_at, views::text from research_videos where owner_channel_id = $1", [owner]),
    db.query<{ source: "hackernews" | "wikimedia"; topic: string; signal: string; url: string }>("select source, topic, signal::text, url from research_trends order by signal desc"),
  ]);
  const names = new Map(watch.rows.map((w) => [w.competitor_id, w.title]));
  return {
    channels: chans.rows.map((c) => ({ id: c.id, channelId: c.channel_id, title: c.title || c.channel_id })),
    searchesToday: used,
    searchLimit: SEARCH_DAILY_SHOWN,
    searchStop: SEARCH_DAILY_MAX,
    suggestions: sug.rows.map((r) => ({ competitorId: r.competitor_id, title: r.title, score: Number(r.score), reason: r.reason, subs: Number(r.subs) })),
    watching: watch.rows.map((r) => ({ competitorId: r.competitor_id, title: r.title, videos: Number(r.videos), refreshedAtIst: r.ist })),
    outliers: findOutliers(vids.rows.map((r) => ({ videoId: r.video_id, competitorId: r.competitor_id, title: r.title, publishedAt: r.published_at, views: Number(r.views) })), now)
      .map((o) => ({ ...o, channel: names.get(o.competitorId) ?? o.competitorId })),
    trends: {
      hackernews: trends.rows.filter((t) => t.source === "hackernews").map((t) => ({ topic: t.topic, signal: Number(t.signal), url: t.url })),
      wikimedia: trends.rows.filter((t) => t.source === "wikimedia").map((t) => ({ topic: t.topic, signal: Number(t.signal), url: t.url })),
    },
  };
}
