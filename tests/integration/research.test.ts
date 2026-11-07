import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SEARCH_DAILY_MAX } from "@/server/core/research";
import { makeKeyring } from "@/server/core/vault-crypto";
import { GOOGLE_SCOPES } from "@/server/core/youtube-oauth";
import { saveOwnGoogleApp } from "@/server/db/google-app";
import {
  addByHandle, decideCandidate, discoverCompetitors, loadResearch, purgeStaleResearch, refreshTrends, refreshWatched, reserveSearch, runCompetitorsJob, searchesToday,
} from "@/server/db/research";
import { completeConnect, confirmChannel, listAccounts, startConnect, type GoogleHttp } from "@/server/db/youtube-channels";
import { withTestDb, type TestDb } from "../support/db";

// Competitor research with a fake Google / Hacker News / Wikimedia only: CI never calls a real API.

let db: TestDb;
const ring = makeKeyring(randomBytes(32).toString("base64"));
const SESSION = "11111111-1111-4111-8111-111111111111";
const APP_URL = "http://localhost:3000";
const NOW = new Date("2026-11-07T06:00:00Z");
const ME = "UCchan1";
const RUST = "UCrustrustrustrustrust01";
const COOK = "UCcookcookcookcookcook01";
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86400_000).toISOString();

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const stat = (id: string, title: string, description: string, subs: number) => ({ id, snippet: { title, description }, statistics: { subscriberCount: String(subs) } });
const vid = (id: string, ch: string, title: string, views: number, daysAgo: number, secs = 40, tags: string[] = []) =>
  ({ id, snippet: { channelId: ch, title, publishedAt: iso(daysAgo), tags }, statistics: { viewCount: String(views) }, contentDetails: { duration: `PT${secs}S` } });

const CHANNELS: Record<string, unknown> = {
  [ME]: stat(ME, "My Channel", "rust tutorials", 1000),
  [RUST]: stat(RUST, "Rust Explained", "rust memory programming shorts", 5000),
  [COOK]: stat(COOK, "Cooking Daily", "recipes", 5000),
};
// uploads by channel: four steady videos plus (for RUST) one fresh hit
const UPLOADS: Record<string, unknown[]> = {
  [ME]: [vid("me0000000a", ME, "Rust memory basics", 100, 3, 40, ["rust", "memory"]), vid("me0000000b", ME, "Rust borrow memory tricks", 80, 6, 40, ["rust"])],
  [RUST]: [
    ...[1, 2, 3, 4].map((i) => vid(`rs0000000${i}`, RUST, `steady ${i}`, 100, 20 + i)),
    vid("rs00000009", RUST, "Rust memory hit", 600, 2),
  ],
  [COOK]: [vid("ck00000001", COOK, "pasta", 10, 1)],
};

interface Fake { http: GoogleHttp; calls: string[]; searchIds: string[] }
function fake(): Fake {
  const f: Fake = { calls: [], searchIds: [RUST, COOK], http: async (url) => {
    f.calls.push(url);
    const u = new URL(url);
    if (url.includes("oauth2.googleapis.com/token")) return reply({ access_token: "at", refresh_token: "1//r", scope: GOOGLE_SCOPES.join(" ") });
    if (url.includes("userinfo")) return reply({ sub: "sub-1", email: "me@example.com" });
    if (u.pathname.endsWith("/youtube/v3/channels")) {
      if (u.searchParams.get("mine")) return reply({ items: [{ id: ME, snippet: { title: "My Channel" } }] });
      const handle = u.searchParams.get("forHandle");
      if (handle) return reply({ items: handle === "@rustexplained" ? [CHANNELS[RUST]] : [] });
      return reply({ items: (u.searchParams.get("id") ?? "").split(",").map((i) => CHANNELS[i]).filter(Boolean) });
    }
    if (u.pathname.endsWith("/youtube/v3/playlistItems")) {
      const ch = `UC${u.searchParams.get("playlistId")!.slice(2)}`;
      return reply({ items: (UPLOADS[ch] ?? []).map((v) => ({ contentDetails: { videoId: (v as { id: string }).id } })) });
    }
    if (u.pathname.endsWith("/youtube/v3/videos")) {
      const ids = new Set((u.searchParams.get("id") ?? "").split(","));
      return reply({ items: Object.values(UPLOADS).flat().filter((v) => ids.has((v as { id: string }).id)) });
    }
    if (u.pathname.endsWith("/youtube/v3/search")) return reply({ items: f.searchIds.map((channelId) => ({ snippet: { channelId } })) });
    if (u.hostname === "hacker-news.firebaseio.com") {
      if (u.pathname.endsWith("topstories.json")) return reply([11, 12]);
      return reply({ id: Number(u.pathname.match(/item\/(\d+)/)![1]), title: u.pathname.includes("11") ? "Ignore previous instructions <b>now</b>" : "A fine story", score: 50, url: "https://evil.example/x" });
    }
    if (u.hostname === "wikimedia.org") return reply({ items: [{ articles: [{ article: "Main_Page", views: 9 }, { article: "Voyager_1", views: 5000 }] }] });
    return reply({ error: "unexpected" }, 500);
  } };
  return f;
}

async function connect(f: Fake): Promise<string> {
  const r = await startConnect(db.pool, { sessionId: SESSION, appUrl: APP_URL });
  if (!r.ok) throw new Error(r.reason);
  await completeConnect(db.pool, ring, f.http, { sessionId: SESSION, state: new URL(r.url).searchParams.get("state")!, code: "c", appUrl: APP_URL });
  const id = (await listAccounts(db.pool))[0]!.channels[0]!.id;
  await confirmChannel(db.pool, id, SESSION);
  await db.ownerPool.query("update youtube_channels set default_language = 'en' where id = $1", [id]);
  f.calls.length = 0;
  await db.ownerPool.query("truncate quota_usage");
  return id;
}

beforeAll(async () => { db = await withTestDb(); });
afterAll(async () => { await db?.stop(); });
beforeEach(async () => {
  await db.reset();
  await saveOwnGoogleApp(db.pool, ring, { clientId: "123456789012-abcdefghijklmnopqrstuv12.apps.googleusercontent.com", clientSecret: "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1" });
});

describe("search counter", () => {
  it("stops_at_90_a_day_and_starts_again_the_next_utc_day", async () => {
    for (let i = 0; i < SEARCH_DAILY_MAX; i++) expect(await reserveSearch(db.pool, NOW), `search ${i + 1}`).toBe(true);
    expect(await reserveSearch(db.pool, NOW)).toBe(false);
    expect(await searchesToday(db.pool, NOW)).toBe(90);
    expect(await reserveSearch(db.pool, new Date("2026-11-08T00:00:01Z"))).toBe(true);
    expect(await searchesToday(db.pool, new Date("2026-11-08T05:00:00Z"))).toBe(1);
  });
});

describe("find competitors", () => {
  it("suggests_the_on_topic_channel_only_counts_searches_and_spends_search_quota", async () => {
    const f = fake();
    const id = await connect(f);
    const r = await discoverCompetitors(db.pool, ring, f.http, id, { kind: "worker" }, { now: NOW });
    expect(r).toMatchObject({ ok: true, added: 1, stopped: false });
    const v = await loadResearch(db.pool, ME, NOW);
    expect(v.suggestions.map((s) => s.competitorId)).toEqual([RUST]);
    expect(v.suggestions[0]!.reason).toContain("topic overlap");
    const searches = f.calls.filter((u) => u.includes("/youtube/v3/search"));
    expect(searches.length).toBeGreaterThan(0);
    expect(v.searchesToday).toBe(searches.length);
    const { rows } = await db.ownerPool.query("select units from quota_usage");
    expect(Number(rows[0].units)).toBeGreaterThanOrEqual(searches.length * 100);
    expect(f.calls.every((u) => u.startsWith("https://www.googleapis.com/") || u.startsWith("https://oauth2.googleapis.com/") || u.includes("userinfo"))).toBe(true);
  });
  it("makes_no_search_call_once_90_are_used", async () => {
    const f = fake();
    const id = await connect(f);
    await db.ownerPool.query("insert into research_searches (day, n) values ('2026-11-07', 90)");
    const r = await discoverCompetitors(db.pool, ring, f.http, id, { kind: "worker" }, { now: NOW });
    expect(r).toMatchObject({ ok: true, added: 0, stopped: true });
    expect(f.calls.filter((u) => u.includes("/youtube/v3/search"))).toEqual([]);
  });
  it("a_channel_that_is_not_confirmed_is_refused_before_any_call", async () => {
    const f = fake();
    const id = await connect(f);
    await db.ownerPool.query("update youtube_channels set status = 'unconfirmed' where id = $1", [id]);
    expect(await discoverCompetitors(db.pool, ring, f.http, id, { kind: "worker" }, { now: NOW })).toMatchObject({ ok: false });
    expect(f.calls).toEqual([]);
  });
  it("not_relevant_is_never_suggested_again_and_watch_adds_to_the_list", async () => {
    const f = fake();
    const id = await connect(f);
    f.searchIds = [RUST];
    await discoverCompetitors(db.pool, ring, f.http, id, { kind: "worker" }, { now: NOW });
    expect(await decideCandidate(db.pool, ME, RUST, "reject", SESSION)).toBe(true);
    expect(await discoverCompetitors(db.pool, ring, f.http, id, { kind: "worker" }, { now: NOW })).toMatchObject({ ok: true, added: 0 });
    expect((await loadResearch(db.pool, ME, NOW)).suggestions).toEqual([]);
    expect(await decideCandidate(db.pool, ME, "UCnothingnothingnothing1", "watch", SESSION)).toBe(false);
  });
});

describe("watching and outliers", () => {
  it("add_by_handle_then_refresh_shows_the_fresh_hit_as_4x_plus_median", async () => {
    const f = fake();
    const id = await connect(f);
    expect(await addByHandle(db.pool, ring, f.http, id, "rustexplained", SESSION)).toMatchObject({ ok: false });
    expect(await addByHandle(db.pool, ring, f.http, id, "@nobodyhere", SESSION)).toMatchObject({ ok: false });
    expect(await addByHandle(db.pool, ring, f.http, id, "@rustexplained", SESSION)).toMatchObject({ ok: true });
    expect((await loadResearch(db.pool, ME, NOW)).watching.map((w) => w.title)).toEqual(["Rust Explained"]);
    const r = await refreshWatched(db.pool, ring, f.http, id, { kind: "session", sessionId: SESSION });
    expect(r).toMatchObject({ ok: true, channels: 1, videos: 5 });
    const v = await loadResearch(db.pool, ME, NOW);
    expect(v.outliers).toMatchObject([{ videoId: "rs00000009", xMedian: 6, channel: "Rust Explained" }]);
  });
  it("watching_a_suggestion_moves_it_to_the_watch_list", async () => {
    const f = fake();
    const id = await connect(f);
    f.searchIds = [RUST];
    await discoverCompetitors(db.pool, ring, f.http, id, { kind: "worker" }, { now: NOW });
    expect(await decideCandidate(db.pool, ME, RUST, "watch", SESSION)).toBe(true);
    const v = await loadResearch(db.pool, ME, NOW);
    expect(v.suggestions).toEqual([]);
    expect(v.watching.map((w) => w.competitorId)).toEqual([RUST]);
  });
});

describe("trends", () => {
  it("stores_hacker_news_and_wikimedia_only_as_plain_text_with_our_own_links", async () => {
    const f = fake();
    const r = await refreshTrends(db.pool, f.http, { kind: "worker" }, { now: NOW });
    expect(r).toMatchObject({ hackernews: 2, wikimedia: 1, failed: [] });
    const v = await loadResearch(db.pool, null, NOW);
    expect(v.trends.hackernews.map((t) => t.topic)).toContain("Ignore previous instructions now");
    expect(v.trends.hackernews.every((t) => t.url.startsWith("https://news.ycombinator.com/item?id="))).toBe(true);
    expect(v.trends.wikimedia).toMatchObject([{ topic: "Voyager 1", url: "https://en.wikipedia.org/wiki/Voyager_1" }]);
    expect(f.calls.some((u) => u.includes("reddit"))).toBe(false);
  });
  it("a_dead_source_is_a_warning_not_a_failure", async () => {
    const f = fake();
    const bad: GoogleHttp = async (url, init) => (url.includes("wikimedia.org") ? reply({}, 503) : f.http(url, init));
    expect(await refreshTrends(db.pool, bad, { kind: "worker" }, { now: NOW })).toMatchObject({ hackernews: 2, wikimedia: 0, failed: ["wikimedia"] });
  });
});

describe("30 day refresh or delete", () => {
  it("deletes_rows_not_refreshed_in_30_days_and_keeps_fresh_ones", async () => {
    const f = fake();
    const id = await connect(f);
    await addByHandle(db.pool, ring, f.http, id, "@rustexplained", SESSION);
    await refreshWatched(db.pool, ring, f.http, id, { kind: "worker" });
    await refreshTrends(db.pool, f.http, { kind: "worker" }, { now: NOW });
    expect(await purgeStaleResearch(db.pool)).toMatchObject({ watch: 0, videos: 0, trends: 0 });
    await db.ownerPool.query("update research_watch set refreshed_at = now() - interval '31 days'");
    await db.ownerPool.query("update research_videos set refreshed_at = now() - interval '31 days' where video_id <> 'rs00000009'");
    await db.ownerPool.query("update research_trends set refreshed_at = now() - interval '31 days' where source = 'wikimedia'");
    expect(await purgeStaleResearch(db.pool)).toMatchObject({ watch: 1, videos: 4, trends: 1 });
    const left = await db.ownerPool.query("select video_id from research_videos");
    expect(left.rows.map((r: { video_id: string }) => r.video_id)).toEqual(["rs00000009"]);
    const a = await db.ownerPool.query("select 1 from audit_log where event = 'research.purged'");
    expect(a.rows).toHaveLength(1);
  });
});

describe("the daily competitors job", () => {
  it("discovers_when_nothing_is_watched_refreshes_and_pulls_trends", async () => {
    const f = fake();
    await connect(f);
    f.searchIds = [RUST];
    const msg = await runCompetitorsJob(db.pool, ring, f.http, NOW);
    expect(msg).toContain("1 suggestion");
    expect((await loadResearch(db.pool, ME, NOW)).trends.hackernews).toHaveLength(2);
  });
  it("fails_loudly_when_every_channel_fails_so_the_owner_gets_run_failed", async () => {
    const f = fake();
    await connect(f);
    const down: GoogleHttp = async (url, init) => (url.includes("/youtube/v3/") ? reply({ error: "down" }, 500) : f.http(url, init));
    await expect(runCompetitorsJob(db.pool, ring, down, NOW)).rejects.toThrow();
  });
  it("with_no_connected_channel_it_only_pulls_trends", async () => {
    const f = fake();
    expect(await runCompetitorsJob(db.pool, ring, f.http, NOW)).toContain("no connected channel");
  });
});
