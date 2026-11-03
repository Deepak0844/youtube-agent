import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeKeyring } from "@/server/core/vault-crypto";
import { GOOGLE_SCOPES } from "@/server/core/youtube-oauth";
import { saveOwnGoogleApp } from "@/server/db/google-app";
import { hasSecret } from "@/server/db/vault";
import { completeConnect, confirmChannel, disconnectChannel, getAccessToken, listAccounts, reserveQuota, startConnect, type GoogleHttp } from "@/server/db/youtube-channels";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
const ring = makeKeyring(randomBytes(32).toString("base64"));
const SESSION = "11111111-1111-4111-8111-111111111111";
const APP_URL = "http://localhost:3000";
const REFRESH = "1//refresh-token-value-that-must-stay-in-the-vault";

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fakeHttp = (over: { token?: Response; channels?: unknown; sub?: string } = {}): GoogleHttp => async (url) => {
  if (url.includes("oauth2.googleapis.com/token")) return over.token ?? reply({ access_token: "at", refresh_token: REFRESH, scope: GOOGLE_SCOPES.join(" ") });
  if (url.includes("userinfo")) return reply({ sub: over.sub ?? "sub-1", email: "me@example.com" });
  return reply(over.channels ?? { items: [{ id: "UCchan1", snippet: { title: "My Channel" } }] });
};

const tokenName = async () => (await db.ownerPool.query("select token_secret_name from youtube_channels limit 1")).rows[0].token_secret_name as string;
const connect = (http: GoogleHttp = fakeHttp()) => (async () => completeConnect(db.pool, ring, http, { sessionId: SESSION, state: await begin(), code: "c", appUrl: APP_URL }))();
const status = async () => (await listAccounts(db.pool)).flatMap((a) => a.channels).map((c) => c.status);

async function begin(): Promise<string> {
  const r = await startConnect(db.pool, { sessionId: SESSION, appUrl: APP_URL });
  if (!r.ok) throw new Error(r.reason);
  return new URL(r.url).searchParams.get("state")!;
}

beforeAll(async () => {
  db = await withTestDb();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.ownerPool.query("truncate google_accounts, youtube_channels, oauth_states, quota_usage, google_apps, secrets, audit_log cascade");
  await saveOwnGoogleApp(db.pool, ring, { clientId: "123456789012-abcdefghijklmnopqrstuv12.apps.googleusercontent.com", clientSecret: "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1" });
});

describe("connect flow", () => {
  it("lands unconfirmed, token only in the vault, state is single use", async () => {
    const state = await begin();
    const r = await completeConnect(db.pool, ring, fakeHttp(), { sessionId: SESSION, state, code: "c", appUrl: APP_URL });
    expect(r).toEqual({ ok: true, channelIds: ["UCchan1"] });
    const accts = await listAccounts(db.pool);
    expect(accts[0]!.channels[0]).toMatchObject({ channelId: "UCchan1", status: "unconfirmed" });
    expect(await hasSecret(db.pool, await tokenName())).toBe(true);
    const dump = JSON.stringify((await db.ownerPool.query("select * from youtube_channels")).rows) + JSON.stringify((await db.ownerPool.query("select * from audit_log")).rows);
    expect(dump).not.toContain(REFRESH);
    expect(await completeConnect(db.pool, ring, fakeHttp(), { sessionId: SESSION, state, code: "c", appUrl: APP_URL })).toEqual({ ok: false, reason: "state" });
  });

  it("rejects a state from another session and an expired state", async () => {
    const state = await begin();
    expect(await completeConnect(db.pool, ring, fakeHttp(), { sessionId: "22222222-2222-4222-8222-222222222222", state, code: "c", appUrl: APP_URL })).toEqual({ ok: false, reason: "state" });
    await db.ownerPool.query("update oauth_states set expires_at = now() - interval '1 second'");
    expect(await completeConnect(db.pool, ring, fakeHttp(), { sessionId: SESSION, state, code: "c", appUrl: APP_URL })).toEqual({ ok: false, reason: "state" });
  });

  it("refuses missing refresh token or missing scopes", async () => {
    const t1 = reply({ access_token: "at", scope: GOOGLE_SCOPES.join(" ") });
    expect(await completeConnect(db.pool, ring, fakeHttp({ token: t1 }), { sessionId: SESSION, state: await begin(), code: "c", appUrl: APP_URL })).toEqual({ ok: false, reason: "no_refresh_token" });
    const t2 = reply({ access_token: "at", refresh_token: REFRESH, scope: "openid email" });
    expect(await completeConnect(db.pool, ring, fakeHttp({ token: t2 }), { sessionId: SESSION, state: await begin(), code: "c", appUrl: APP_URL })).toEqual({ ok: false, reason: "scopes" });
  });

  it("confirm, then invalid_grant marks needs_reconnect with an audit row; disconnect deletes the token", async () => {
    await completeConnect(db.pool, ring, fakeHttp(), { sessionId: SESSION, state: await begin(), code: "c", appUrl: APP_URL });
    const id = (await listAccounts(db.pool))[0]!.channels[0]!.id;
    expect(await confirmChannel(db.pool, id, SESSION)).toBe(true);
    expect(await getAccessToken(db.pool, ring, fakeHttp({ token: reply({ access_token: "at2" }) }), id)).toEqual({ ok: true, accessToken: "at2" });
    expect(await getAccessToken(db.pool, ring, fakeHttp({ token: reply({ error: "invalid_grant" }, 400) }), id)).toEqual({ ok: false, reason: "needs_reconnect" });
    expect((await listAccounts(db.pool))[0]!.channels[0]!.status).toBe("needs_reconnect");
    const ev = (await db.ownerPool.query("select event from audit_log where event like 'youtube.%' order by id")).rows.map((r: { event: string }) => r.event);
    expect(ev).toEqual(["youtube.channel_connected", "youtube.channel_confirmed", "youtube.refresh_failed"]);
    // Reconnect keeps a confirmed channel confirmed.
    await completeConnect(db.pool, ring, fakeHttp(), { sessionId: SESSION, state: await begin(), code: "c", appUrl: APP_URL });
    expect((await listAccounts(db.pool))[0]!.channels[0]!.status).toBe("connected");
    const name = await tokenName();
    expect(await disconnectChannel(db.pool, ring, fakeHttp(), id, SESSION)).toBe(true);
    expect(await hasSecret(db.pool, name)).toBe(false);
    expect(await listAccounts(db.pool)).toEqual([]);
  });
});

describe("review fixes", () => {
  it("reconnect from a different Google account needs confirming again, with both account ids audited", async () => {
    await connect();
    await confirmChannel(db.pool, (await listAccounts(db.pool))[0]!.channels[0]!.id, SESSION);
    await connect(fakeHttp({ sub: "sub-2" }));
    expect(await status()).toEqual(["unconfirmed"]);
    const a = (await db.ownerPool.query("select detail from audit_log where event = 'youtube.channel_connected' order by id desc limit 1")).rows[0].detail;
    expect(a.oldAccountId).toBeTruthy();
    expect(a.newAccountId).not.toBe(a.oldAccountId);
    expect(await listAccounts(db.pool)).toHaveLength(1); // emptied old account removed
  });

  it("unconfirmed channel: no token use, stays unconfirmed through reconnect", async () => {
    await connect();
    const id = (await listAccounts(db.pool))[0]!.channels[0]!.id;
    expect(await getAccessToken(db.pool, ring, fakeHttp({ token: reply({ error: "invalid_grant" }, 400) }), id)).toEqual({ ok: false, reason: "unconfirmed" });
    await connect();
    expect(await status()).toEqual(["unconfirmed"]);
  });

  it("an error other than invalid_grant leaves the status alone", async () => {
    await connect();
    const id = (await listAccounts(db.pool))[0]!.channels[0]!.id;
    await confirmChannel(db.pool, id, SESSION);
    expect(await getAccessToken(db.pool, ring, fakeHttp({ token: reply({ error: "server_error" }, 500) }), id)).toEqual({ ok: false, reason: "unavailable" });
    expect(await status()).toEqual(["connected"]);
  });

  it("invalid_grant for a token replaced meanwhile does not flip the status", async () => {
    await connect();
    const id = (await listAccounts(db.pool))[0]!.channels[0]!.id;
    await confirmChannel(db.pool, id, SESSION);
    const http: GoogleHttp = async () => {
      await db.ownerPool.query("update secrets set updated_at = now() + interval '1 minute' where name = $1", [await tokenName()]);
      return reply({ error: "invalid_grant" }, 400);
    };
    expect((await getAccessToken(db.pool, ring, http, id)).ok).toBe(false);
    expect(await status()).toEqual(["connected"]);
  });

  it("disconnect revokes only when it was the account's last channel, and never fails if revoke fails", async () => {
    const two = { items: [{ id: "UCchan1", snippet: { title: "A" } }, { id: "UCchan2", snippet: { title: "B" } }] };
    await connect(fakeHttp({ channels: two }));
    const ids = (await listAccounts(db.pool))[0]!.channels.map((c) => c.id);
    const revokes: string[] = [];
    const http: GoogleHttp = async (url) => {
      if (url.includes("revoke")) {
        revokes.push(url);
        throw new Error("network");
      }
      return reply({});
    };
    expect(await disconnectChannel(db.pool, ring, http, ids[0]!, SESSION)).toBe(true);
    expect(revokes).toHaveLength(0);
    expect(await disconnectChannel(db.pool, ring, http, ids[1]!, SESSION)).toBe(true);
    expect(revokes).toHaveLength(1);
  });

  it("quota exhausted stops the connect", async () => {
    await db.ownerPool.query("insert into quota_usage (day, units) values ($1, 8000)", [(await import("@/server/core/youtube-oauth")).quotaDay(new Date())]);
    expect(await connect()).toEqual({ ok: false, reason: "quota" });
  });
});

describe("quota guard", () => {
  it("refuses a call that would pass the budget and counts nothing for it", async () => {
    const now = new Date("2026-11-04T12:00:00Z");
    expect(await reserveQuota(db.pool, "videos.insert", { budget: 2000, now })).toBe(true);
    expect(await reserveQuota(db.pool, "videos.insert", { budget: 2000, now })).toBe(false);
    expect(await reserveQuota(db.pool, "channels.list", { budget: 2000, now })).toBe(true);
    const { rows } = await db.ownerPool.query("select units from quota_usage");
    expect(rows[0].units).toBe(1601);
  });
});
