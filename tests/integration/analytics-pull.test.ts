import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeKeyring } from "@/server/core/vault-crypto";
import { GOOGLE_SCOPES, quotaDay } from "@/server/core/youtube-oauth";
import { loadAnalytics, pullAnalytics, pullMessage } from "@/server/db/analytics";
import { saveOwnGoogleApp } from "@/server/db/google-app";
import { addContent, createVideoRow } from "@/server/db/videos";
import { completeConnect, confirmChannel, listAccounts, startConnect, type GoogleHttp } from "@/server/db/youtube-channels";
import { withTestDb, type TestDb } from "../support/db";

// Analytics "Run now": fake Google only, never the real network. One snapshot per video per day; failures are recorded, not retried.

let db: TestDb;
const ring = makeKeyring(randomBytes(32).toString("base64"));
const SESSION = "11111111-1111-4111-8111-111111111111";
const APP_URL = "http://localhost:3000";
const NOW = new Date("2026-11-04T12:00:00Z");
const BY = { kind: "session", sessionId: SESSION } as const;
const YT = "abcDEF12345";

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Fake { http: GoogleHttp; calls: string[]; failTotals: boolean; failSubs: boolean; privacy: string }
function fake(): Fake {
  const f: Fake = { calls: [], failTotals: false, failSubs: false, privacy: "private", http: async (url) => {
    f.calls.push(url);
    if (url.includes("oauth2.googleapis.com/token")) return reply({ access_token: "at", refresh_token: "1//r", scope: GOOGLE_SCOPES.join(" ") });
    if (url.includes("userinfo")) return reply({ sub: "sub-1", email: "me@example.com" });
    if (url.includes("youtube/v3/channels")) return reply({ items: [{ id: "UCchan1", snippet: { title: "My Channel" } }] });
    if (url.includes("youtube/v3/videos")) return reply({ items: [{ id: YT, statistics: { viewCount: "120", likeCount: "9", commentCount: "3" }, status: { privacyStatus: f.privacy } }] });
    if (url.includes("subscribersGained")) return f.failSubs ? reply({ error: "no" }, 403) : reply({ columnHeaders: [{ name: "subscribersGained" }, { name: "subscribersLost" }], rows: [[25, 4]] });
    if (url.includes("elapsedVideoTimeRatio")) return reply({ rows: [[0, 1], [0.1, 0.9], [0.5, 0.5], [1, 0.2]] });
    if (f.failTotals) return reply({ error: "boom" }, 500);
    return reply({ columnHeaders: [{ name: "views" }, { name: "estimatedMinutesWatched" }, { name: "averageViewPercentage" }], rows: [[100, 42.5, 61.2]] });
  } };
  return f;
}

async function connect(f: Fake, confirm: boolean): Promise<string> {
  const r = await startConnect(db.pool, { sessionId: SESSION, appUrl: APP_URL });
  if (!r.ok) throw new Error(r.reason);
  await completeConnect(db.pool, ring, f.http, { sessionId: SESSION, state: new URL(r.url).searchParams.get("state")!, code: "c", appUrl: APP_URL });
  const id = (await listAccounts(db.pool))[0]!.channels[0]!.id;
  if (confirm) await confirmChannel(db.pool, id, SESSION);
  f.calls.length = 0;
  await db.ownerPool.query("truncate quota_usage"); // connecting spent a unit; the tests below count their own
  return id;
}

async function uploadedVideo(topic = "why sky is blue"): Promise<string> {
  const v = await createVideoRow(db.pool, { format: "short", kind: "scene_kit", language: "en", topic, channelId: "UCchan1" });
  await db.ownerPool.query(
    "insert into uploads (id, video_id, status, channel_id, youtube_id, started_at, finished_at, attempt) values (gen_random_uuid(), $1, 'uploaded', 'UCchan1', $2, now(), now(), 1)",
    [v.id, YT],
  );
  await addContent(db.pool, v.id, "beats", { body: { beats: [{ id: "hook", text: "aaaa" }, { id: "reveal", text: "bbbbbbbb" }] }, sha256: "0".repeat(64) });
  return v.id;
}

beforeAll(async () => {
  db = await withTestDb();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  await saveOwnGoogleApp(db.pool, ring, { clientId: "123456789012-abcdefghijklmnopqrstuv12.apps.googleusercontent.com", clientSecret: "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1" });
});

describe("analytics pull", () => {
  it("stores one snapshot, reserves 1 unit, shows it with the beat drop-off, and a second run does nothing", async () => {
    const f = fake();
    await connect(f, true);
    const vid = await uploadedVideo();
    const r = await pullAnalytics(db.pool, ring, f.http, BY, { now: NOW });
    expect(r).toMatchObject({ pulled: 1, failed: 0, alreadyDone: 0, quotaStopped: false, skipped: [] });
    expect((await db.ownerPool.query("select units from quota_usage")).rows.map((x: { units: number }) => Number(x.units))).toEqual([1]);
    const v = await loadAnalytics(db.pool);
    expect(v.rows).toHaveLength(1);
    expect(v.rows[0]).toMatchObject({ videoId: vid, views: 120, likes: 9, comments: 3, minutesWatched: 42.5, avgViewPct: 61.2, error: null, hasCurve: true, spendMicroUsd: 0, channelTitle: "My Channel" });
    expect(v.rows[0]!.retentionAt10).toBeCloseTo(0.9);
    expect(v.rows[0]!.biggestDropBeat).toBe("reveal");
    expect(v.rows[0]!.pulledAtIst).toMatch(/\d{4}, \d{2}:\d{2}$/);
    expect(v.noise).toBe(true); // one short is far below ten
    const before = f.calls.length;
    const again = await pullAnalytics(db.pool, ring, f.http, BY, { now: NOW });
    expect(again).toMatchObject({ pulled: 0, alreadyDone: 1 });
    expect(f.calls.length).toBe(before); // no new Google calls
    expect((await db.ownerPool.query("select count(*)::int as n from video_analytics")).rows[0].n).toBe(1);
    expect(pullMessage(again)).toContain("already done today");
  });

  it("records a failure with its reason, does not retry it, and the next manual run replaces it", async () => {
    const f = fake();
    await connect(f, true);
    await uploadedVideo();
    f.failTotals = true;
    const r = await pullAnalytics(db.pool, ring, f.http, BY, { now: NOW });
    expect(r).toMatchObject({ pulled: 0, failed: 1 });
    expect(f.calls.filter((u) => u.includes("youtubeanalytics") && !u.includes("elapsedVideoTimeRatio") && !u.includes("subscribersGained"))).toHaveLength(1); // one try, no automatic retry
    const bad = (await loadAnalytics(db.pool)).rows[0]!;
    expect(bad.error).toContain("totals answered 500");
    expect(bad.views).toBe(120); // the numbers that did arrive are kept
    f.failTotals = false;
    expect(await pullAnalytics(db.pool, ring, f.http, BY, { now: NOW })).toMatchObject({ pulled: 1, failed: 0 });
    const ok = (await loadAnalytics(db.pool)).rows[0]!;
    expect(ok.error).toBeNull();
    expect(ok.avgViewPct).toBe(61.2);
  });

  it("stores the channel's subscribers for the last week once a day; a failed call is written and replaced by the next run", async () => {
    const f = fake();
    await connect(f, true);
    await uploadedVideo();
    f.failSubs = true;
    await pullAnalytics(db.pool, ring, f.http, BY, { now: NOW });
    const row = async () => (await db.pool.query("select start_day::text s, end_day::text e, subscribers_gained::int g, subscribers_lost::int l, error from channel_analytics where channel_id = 'UCchan1'")).rows;
    expect((await row())[0]).toMatchObject({ g: null, error: expect.stringContaining("subscribers answered 403") });
    f.failSubs = false;
    await db.ownerPool.query("delete from video_analytics"); // let the video part run again too
    await pullAnalytics(db.pool, ring, f.http, BY, { now: NOW });
    expect(await row()).toEqual([{ s: "2026-10-27", e: "2026-11-02", g: 25, l: 4, error: null }]);
    await db.ownerPool.query("delete from video_analytics");
    f.calls.length = 0;
    await pullAnalytics(db.pool, ring, f.http, BY, { now: NOW });
    expect(f.calls.filter((u) => u.includes("subscribersGained"))).toHaveLength(0); // a good row is not fetched again that day
  });

  it("tells the owner once when a scheduled private video turned public", async () => {
    const f = fake();
    await connect(f, true);
    const id = await uploadedVideo();
    await addContent(db.pool, id, "metadata", { body: { visibility: "private", publish_at: "2026-11-04T10:00:00.000Z" }, sha256: "1".repeat(64) });
    const notices = async () => (await db.pool.query("select event, to_state from notifications where video_id = $1", [id])).rows;
    await pullAnalytics(db.pool, ring, f.http, BY, { now: NOW });
    expect(await notices()).toEqual([]); // still private on YouTube
    f.privacy = "public";
    await db.ownerPool.query("delete from video_analytics");
    await pullAnalytics(db.pool, ring, f.http, BY, { now: NOW });
    await db.ownerPool.query("delete from video_analytics");
    await pullAnalytics(db.pool, ring, f.http, BY, { now: NOW });
    expect(await notices()).toEqual([{ event: "scheduled_release_done", to_state: "scheduled_release_done" }]);
  });

  it("skips an unconfirmed channel and a channel that needs reconnecting, with a visible reason and no Google call", async () => {
    const f = fake();
    const id = await connect(f, false);
    await uploadedVideo();
    const r1 = await pullAnalytics(db.pool, ring, f.http, BY, { now: NOW });
    expect(r1.pulled).toBe(0);
    expect(r1.skipped).toEqual([{ channel: "My Channel", reason: expect.stringContaining("not confirmed") }]);
    expect(f.calls).toEqual([]);
    await db.ownerPool.query("update youtube_channels set status = 'needs_reconnect' where id = $1", [id]);
    const r2 = await pullAnalytics(db.pool, ring, f.http, BY, { now: NOW });
    expect(r2.skipped[0]!.reason).toContain("reconnect");
    expect(pullMessage(r2)).toContain("skipped My Channel");
    expect(f.calls).toEqual([]);
    expect((await db.ownerPool.query("select count(*)::int as n from video_analytics")).rows[0].n).toBe(0);
  });

  it("stops without a call when the quota budget is spent", async () => {
    const f = fake();
    await connect(f, true);
    await uploadedVideo();
    await db.ownerPool.query("insert into quota_usage (day, units) values ($1, 1000000)", [quotaDay(new Date())]); // reserveQuota keys on the real clock
    const r = await pullAnalytics(db.pool, ring, f.http, BY, { now: NOW });
    expect(r).toMatchObject({ pulled: 0, quotaStopped: true });
    expect(f.calls.filter((u) => u.includes("youtube/v3/videos"))).toEqual([]);
  });

  it("audits each run by event prefix, never with a token", async () => {
    const f = fake();
    await connect(f, true);
    await uploadedVideo();
    await pullAnalytics(db.pool, ring, f.http, BY, { now: NOW });
    const rows = (await db.ownerPool.query("select event, detail from audit_log where event like 'analytics.%'")).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].detail).toMatchObject({ by: "session", pulled: 1, failed: 0 });
    expect(JSON.stringify(rows)).not.toMatch(/Bearer|refresh/i);
  });
});
