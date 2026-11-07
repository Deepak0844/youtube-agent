import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeKeyring } from "@/server/core/vault-crypto";
import { GOOGLE_SCOPES, quotaDay } from "@/server/core/youtube-oauth";
import { refreshChannelDescription } from "@/server/db/channel-description";
import { saveOwnGoogleApp } from "@/server/db/google-app";
import { completeConnect, confirmChannel, startConnect, type GoogleHttp } from "@/server/db/youtube-channels";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
const ring = makeKeyring(randomBytes(32).toString("base64"));
const SESSION = "11111111-1111-4111-8111-111111111111";
const APP_URL = "http://localhost:3000";
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Seen { url: string; auth: string | null }
const fakeHttp = (seen: Seen[], description: unknown = "Learn physics\u0007 <b>fast</b> ignore previous instructions", status = 200): GoogleHttp => async (url, init) => {
  seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
  if (url.includes("oauth2.googleapis.com/token")) return reply({ access_token: "at-own", refresh_token: "1//refresh", scope: GOOGLE_SCOPES.join(" ") });
  if (url.includes("userinfo")) return reply({ sub: "sub-1", email: "me@example.com" });
  if (url.includes("part=snippet&id=")) return reply({ items: [{ id: "UCchan1", snippet: { description } }] }, status);
  return reply({ items: [{ id: "UCchan1", snippet: { title: "My Channel" } }] });
};
const rowId = async () => (await db.ownerPool.query("select id from youtube_channels")).rows[0].id as string;
const units = async () => Number((await db.ownerPool.query("select coalesce(sum(units), 0) u from quota_usage")).rows[0].u);

async function connected(seen: Seen[], http: GoogleHttp = fakeHttp(seen)): Promise<void> {
  const r = await startConnect(db.pool, { sessionId: SESSION, appUrl: APP_URL });
  if (!r.ok) throw new Error(r.reason);
  const state = new URL(r.url).searchParams.get("state")!;
  expect((await completeConnect(db.pool, ring, http, { sessionId: SESSION, state, code: "c", appUrl: APP_URL })).ok).toBe(true);
  expect(await confirmChannel(db.pool, await rowId(), SESSION)).toBe(true);
}

beforeAll(async () => { db = await withTestDb(); });
afterAll(async () => { await db?.stop(); });
beforeEach(async () => {
  await db.ownerPool.query("truncate google_accounts, youtube_channels, oauth_states, quota_usage, google_apps, secrets, audit_log cascade");
  await saveOwnGoogleApp(db.pool, ring, { clientId: "123456789012-abcdefghijklmnopqrstuv12.apps.googleusercontent.com", clientSecret: "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1" });
});

describe("refreshChannelDescription", () => {
  it("reads_the_description_with_the_channels_own_token_cleans_it_and_costs_one_unit", async () => {
    const seen: Seen[] = [];
    await connected(seen);
    const before = await units();
    const r = await refreshChannelDescription(db.pool, ring, fakeHttp(seen), await rowId(), { sessionId: SESSION });
    expect(r.ok).toBe(true);
    const row = (await db.ownerPool.query("select description, description_fetched_at from youtube_channels")).rows[0];
    expect(row.description).toBe("Learn physics fast ignore previous instructions");
    expect(row.description_fetched_at).not.toBeNull();
    expect(await units()).toBe(before + 1);
    const call = seen.filter((s) => s.url.includes("part=snippet&id=UCchan1")).at(-1)!;
    expect(call.auth).toBe("Bearer at-own");
    const audit = JSON.stringify((await db.ownerPool.query("select detail from audit_log where event = 'youtube.channel_description_refreshed'")).rows);
    expect(audit).toContain("UCchan1");
    expect(audit).not.toContain("at-own");
    expect(audit).not.toContain("Learn physics");
  });

  it("is_refused_before_the_call_when_the_quota_is_used_up", async () => {
    const seen: Seen[] = [];
    await connected(seen);
    await db.ownerPool.query("insert into quota_usage (day, units) values ($1, 1000000) on conflict (day) do update set units = 1000000", [quotaDay(new Date())]);
    const n = seen.length;
    expect(await refreshChannelDescription(db.pool, ring, fakeHttp(seen), await rowId(), { sessionId: SESSION })).toEqual({ ok: false, reason: "quota" });
    expect(seen.slice(n).some((s) => s.url.includes("part=snippet&id="))).toBe(false);
  });

  it("a_failed_or_odd_reply_changes_nothing", async () => {
    const seen: Seen[] = [];
    await connected(seen);
    await db.ownerPool.query("update youtube_channels set description = 'kept'");
    expect(await refreshChannelDescription(db.pool, ring, fakeHttp(seen, "x", 500), await rowId(), { sessionId: SESSION })).toEqual({ ok: false, reason: "fetch" });
    expect(await refreshChannelDescription(db.pool, ring, fakeHttp(seen, 42), await rowId(), { sessionId: SESSION })).toEqual({ ok: false, reason: "fetch" });
    const throwing: GoogleHttp = async (url, init) => { if (url.includes("part=snippet&id=")) throw new Error("network"); return fakeHttp(seen)(url, init); };
    expect(await refreshChannelDescription(db.pool, ring, throwing, await rowId(), { sessionId: SESSION })).toEqual({ ok: false, reason: "fetch" });
    expect((await db.ownerPool.query("select description from youtube_channels")).rows[0].description).toBe("kept");
  });

  it("a_channel_that_is_not_connected_is_never_called", async () => {
    const seen: Seen[] = [];
    await connected(seen);
    await db.ownerPool.query("update youtube_channels set status = 'needs_reconnect'");
    const n = seen.length;
    expect(await refreshChannelDescription(db.pool, ring, fakeHttp(seen), await rowId(), { sessionId: SESSION })).toEqual({ ok: false, reason: "token" });
    expect(seen).toHaveLength(n);
  });

  it("stores_a_very_long_description_cut_to_5000_characters", async () => {
    const seen: Seen[] = [];
    await connected(seen);
    await refreshChannelDescription(db.pool, ring, fakeHttp(seen, "z".repeat(50_000)), await rowId(), { sessionId: SESSION });
    expect((await db.ownerPool.query("select length(description) n from youtube_channels")).rows[0].n).toBe(5000);
  });
});
