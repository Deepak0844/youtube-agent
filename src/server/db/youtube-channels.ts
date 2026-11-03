// Connecting YouTube channels through the owner's own Google app. Refresh tokens are written ONLY to the vault; the
// tables hold the vault entry name. Codes, tokens and the client secret are never logged or audited (audit rows carry
// channel ids and reasons only). Every Google call goes through the injected `GoogleHttp` (default: safeFetch), so tests use fakes.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { redirectUriFor, SECRET_NAME } from "@/server/core/google-app";
import {
  CHANNELS_URL,
  DEFAULT_QUOTA_BUDGET,
  STATE_TTL_MS,
  TOKEN_URL,
  USERINFO_URL,
  buildAuthUrl,
  channelSecretName,
  missingScopes,
  scopeLabel,
  parseChannels,
  quotaCost,
  quotaDay,
  type QuotaCall,
  randomToken,
  sha256Hex,
} from "@/server/core/youtube-oauth";
import type { Keyring } from "@/server/core/vault-crypto";
import { recordAudit } from "@/server/db/audit";
import { deleteSecret, getSecret, putSecret } from "@/server/db/vault";
import { safeFetch } from "@/server/providers/net/safe-fetch";

type Ring = Keyring | (() => Keyring);
const keyringOf = (r: Ring) => (typeof r === "function" ? r() : r);

export type GoogleHttp = (url: string, init?: RequestInit) => Promise<Response>;
export const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const defaultGoogleHttp: GoogleHttp = (url, init) => safeFetch(url, init, { mode: "indirect" });

const form = (o: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(o).toString(), // form-encoded: the secret may contain & % +
});

async function appCreds(pool: pg.Pool, ring: Ring): Promise<{ clientId: string; clientSecret: string } | null> {
  const { rows } = await pool.query<{ client_id: string }>("select client_id from google_apps where kind = 'own'");
  if (!rows[0]) return null;
  try {
    return { clientId: rows[0].client_id, clientSecret: await getSecret(pool, keyringOf(ring), SECRET_NAME) };
  } catch {
    return null;
  }
}

export type StartResult = { ok: true; url: string } | { ok: false; reason: "no_app" | "bad_app_url" };

/** Step 1: store a hashed one-time state (bound to the session) + PKCE verifier, return the Google consent URL. */
export async function startConnect(pool: pg.Pool, a: { sessionId: string; appUrl: string | undefined }): Promise<StartResult> {
  const redirect = redirectUriFor(a.appUrl);
  if (!redirect.ok) return { ok: false, reason: "bad_app_url" };
  const { rows } = await pool.query<{ client_id: string }>("select client_id from google_apps where kind = 'own'");
  if (!rows[0]) return { ok: false, reason: "no_app" };
  const state = randomToken();
  const verifier = randomToken();
  await pool.query("delete from oauth_states where expires_at < now()");
  await pool.query("insert into oauth_states (state_hash, session_id, verifier, expires_at) values ($1, $2, $3, now() + $4 * interval '1 millisecond')", [
    sha256Hex(state),
    a.sessionId,
    verifier,
    STATE_TTL_MS,
  ]);
  return { ok: true, url: buildAuthUrl({ clientId: rows[0].client_id, redirectUri: redirect.uri, state, verifier }) };
}

export type CompleteResult =
  | { ok: true; channelIds: string[] }
  | { ok: false; reason: "scopes"; missing: string[] }
  | { ok: false; reason: "state" | "no_app" | "bad_app_url" | "exchange" | "no_refresh_token" | "profile" | "no_channel" | "quota" };

async function json(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const v: unknown = await res.json();
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Step 2 (redirect handler): validate state (single use, same session, unexpired), exchange the code, read the channel. */
export async function completeConnect(
  pool: pg.Pool,
  ring: Ring,
  http: GoogleHttp,
  a: { sessionId: string; state: string; code: string; appUrl: string | undefined },
): Promise<CompleteResult> {
  // Consume first: even a failed attempt burns the state. The session id is part of the match.
  const used = await pool.query<{ verifier: string }>(
    "delete from oauth_states where state_hash = $1 and session_id = $2 and expires_at > now() returning verifier",
    [sha256Hex(a.state), a.sessionId],
  );
  const verifier = used.rows[0]?.verifier;
  if (!verifier) return { ok: false, reason: "state" };
  const redirect = redirectUriFor(a.appUrl);
  if (!redirect.ok) return { ok: false, reason: "bad_app_url" };
  const creds = await appCreds(pool, ring);
  if (!creds) return { ok: false, reason: "no_app" };

  let tokens: Record<string, unknown> | null;
  try {
    const res = await http(TOKEN_URL, form({ code: a.code, client_id: creds.clientId, client_secret: creds.clientSecret, redirect_uri: redirect.uri, grant_type: "authorization_code", code_verifier: verifier }));
    tokens = res.ok ? await json(res) : null;
  } catch {
    tokens = null;
  }
  const access = tokens?.access_token;
  if (typeof access !== "string") return { ok: false, reason: "exchange" };
  const refresh = tokens?.refresh_token;
  if (typeof refresh !== "string" || !refresh) return { ok: false, reason: "no_refresh_token" };
  const scopes = typeof tokens?.scope === "string" ? tokens.scope : "";
  const missing = missingScopes(scopes);
  if (missing.length > 0) return { ok: false, reason: "scopes", missing: missing.map(scopeLabel) };

  // Reserve BEFORE the channels.list call and honour the answer.
  if (!(await reserveQuota(pool, "channels.list"))) return { ok: false, reason: "quota" };
  let sub: string, email: string, channels;
  try {
    const auth = { headers: { authorization: `Bearer ${access}` } };
    const who = await json(await http(USERINFO_URL, auth));
    const ch = await http(CHANNELS_URL, auth);
    channels = ch.ok ? parseChannels(await json(ch)) : [];
    sub = typeof who?.sub === "string" ? who.sub : "";
    email = typeof who?.email === "string" ? who.email.slice(0, 320) : "";
    if (!sub) return { ok: false, reason: "profile" };
  } catch {
    return { ok: false, reason: "profile" };
  }
  if (channels.length === 0) return { ok: false, reason: "no_channel" };

  const client = await pool.connect();
  try {
    await client.query("begin");
    const acct = await client.query<{ id: string }>(
      `insert into google_accounts (google_sub, email) values ($1, $2)
       on conflict (google_sub) do update set email = excluded.email returning id`,
      [sub, email],
    );
    const touchedOld = new Set<string>();
    for (const c of channels) {
      const cur = await client.query<{ id: string; google_account_id: string; status: string; token_secret_name: string }>(
        "select id, google_account_id, status, token_secret_name from youtube_channels where channel_id = $1 for update",
        [c.channelId],
      );
      const old = cur.rows[0];
      const acctId = acct.rows[0]!.id;
      const rowId = old?.id ?? randomUUID();
      const name = old?.token_secret_name ?? channelSecretName(rowId);
      await putSecret(client, keyringOf(ring), name, refresh, { hint: false });
      // New, still-unconfirmed, or moved to a DIFFERENT Google account -> unconfirmed. Same account reconnect keeps it confirmed.
      const status = !old || old.status === "unconfirmed" || old.google_account_id !== acctId ? "unconfirmed" : "connected";
      if (old) {
        await client.query("update youtube_channels set google_account_id = $2, title = $3, scopes = $4, status = $5, updated_at = now() where id = $1", [rowId, acctId, c.title, scopes, status]);
        if (old.google_account_id !== acctId) touchedOld.add(old.google_account_id);
      } else {
        await client.query("insert into youtube_channels (id, google_account_id, channel_id, title, token_secret_name, scopes, status) values ($1, $2, $3, $4, $5, $6, $7)", [rowId, acctId, c.channelId, c.title, name, scopes, status]);
      }
      await recordAudit(client, "youtube.channel_connected", { channelId: c.channelId, status, oldAccountId: old?.google_account_id ?? null, newAccountId: acctId });
    }
    for (const id of touchedOld) {
      await client.query("delete from google_accounts a where a.id = $1 and not exists (select 1 from youtube_channels c where c.google_account_id = a.id)", [id]);
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return { ok: true, channelIds: channels.map((c) => c.channelId) };
}

export async function confirmChannel(pool: pg.Pool, id: string, sessionId: string): Promise<boolean> {
  const r = await pool.query<{ channel_id: string }>("update youtube_channels set status = 'connected', updated_at = now() where id = $1 and status = 'unconfirmed' returning channel_id", [id]);
  if (!r.rows[0]) return false;
  await recordAudit(pool, "youtube.channel_confirmed", { channelId: r.rows[0].channel_id, sessionId });
  return true;
}

/**
 * Deletes the channel row and its vault token in one transaction; drops a Google account left with no channels. After commit,
 * and only when no other channel of that account remains, it asks Google to revoke the token. Best effort: a revoke failure
 * never fails the disconnect.
 */
export async function disconnectChannel(pool: pg.Pool, ring: Ring, http: GoogleHttp, id: string, sessionId: string): Promise<boolean> {
  let token: string | null = null;
  try {
    const n = await pool.query<{ token_secret_name: string }>("select token_secret_name from youtube_channels where id = $1", [id]);
    if (n.rows[0]) token = await getSecret(pool, keyringOf(ring), n.rows[0].token_secret_name);
  } catch {
    token = null;
  }
  const client = await pool.connect();
  let lastOfAccount = false;
  try {
    await client.query("begin");
    const r = await client.query<{ channel_id: string; token_secret_name: string; google_account_id: string }>(
      "delete from youtube_channels where id = $1 returning channel_id, token_secret_name, google_account_id",
      [id],
    );
    const row = r.rows[0];
    if (!row) {
      await client.query("rollback");
      return false;
    }
    await deleteSecret(client, row.token_secret_name);
    const gone = await client.query("delete from google_accounts a where a.id = $1 and not exists (select 1 from youtube_channels c where c.google_account_id = a.id)", [row.google_account_id]);
    lastOfAccount = (gone.rowCount ?? 0) > 0;
    await recordAudit(client, "youtube.channel_disconnected", { channelId: row.channel_id, sessionId, lastOfAccount });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  if (lastOfAccount && token) {
    try {
      await http(REVOKE_URL, form({ token }));
    } catch {
      // best effort
    }
  }
  return true;
}

export type AccessResult = { ok: true; accessToken: string } | { ok: false; reason: "needs_reconnect" | "unconfirmed" | "unavailable" };

/** Trades the vault refresh token for a short-lived access token (never stored). invalid_grant -> needs_reconnect + audit. */
export async function getAccessToken(pool: pg.Pool, ring: Ring, http: GoogleHttp, id: string): Promise<AccessResult> {
  const { rows } = await pool.query<{ channel_id: string; token_secret_name: string; status: string; token_version: string | null }>("select channel_id, token_secret_name, status, (select updated_at::text from secrets where name = token_secret_name) as token_version from youtube_channels where id = $1", [id]);
  const ch = rows[0];
  if (!ch) return { ok: false, reason: "unavailable" };
  if (ch.status === "unconfirmed") return { ok: false, reason: "unconfirmed" }; // never use a token the owner has not confirmed
  if (ch.status === "needs_reconnect") return { ok: false, reason: "needs_reconnect" };
  const creds = await appCreds(pool, ring);
  if (!creds) return { ok: false, reason: "unavailable" };
  let refresh: string;
  try {
    refresh = await getSecret(pool, keyringOf(ring), ch.token_secret_name);
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  let res: Response;
  try {
    res = await http(TOKEN_URL, form({ client_id: creds.clientId, client_secret: creds.clientSecret, refresh_token: refresh, grant_type: "refresh_token" }));
  } catch {
    return { ok: false, reason: "unavailable" }; // network trouble is not a revoked token
  }
  const body = await json(res);
  if (res.ok && typeof body?.access_token === "string") return { ok: true, accessToken: body.access_token };
  if (body?.error === "invalid_grant") {
    // Version is compared as text: a JS Date round trip would drop Postgres' microseconds and never match.
    // Only if the token is still the one we tried (a reconnect in between replaced it) and the owner has not un-confirmed it.
    const u = await pool.query(
      `update youtube_channels set status = 'needs_reconnect', updated_at = now() where id = $1 and status <> 'unconfirmed'
         and (select updated_at::text from secrets where name = token_secret_name) is not distinct from $2::text`,
      [id, ch.token_version],
    );
    if ((u.rowCount ?? 0) > 0) await recordAudit(pool, "youtube.refresh_failed", { channelId: ch.channel_id, reason: "invalid_grant" });
    return { ok: false, reason: (u.rowCount ?? 0) > 0 ? "needs_reconnect" : "unavailable" };
  }
  return { ok: false, reason: "unavailable" };
}

export interface ChannelView {
  id: string;
  channelId: string;
  title: string;
  status: "connected" | "needs_reconnect" | "unconfirmed";
}
export interface AccountView {
  id: string;
  email: string;
  channels: ChannelView[];
}

export async function listAccounts(pool: Pick<pg.Pool, "query">): Promise<AccountView[]> {
  const { rows } = await pool.query<{ aid: string; email: string; id: string | null; channel_id: string; title: string; status: ChannelView["status"] }>(
    `select a.id as aid, a.email, c.id, c.channel_id, c.title, c.status from google_accounts a
       left join youtube_channels c on c.google_account_id = a.id order by a.created_at, a.id, c.created_at, c.id`,
  );
  const out = new Map<string, AccountView>();
  for (const r of rows) {
    const a = out.get(r.aid) ?? { id: r.aid, email: r.email, channels: [] };
    out.set(r.aid, a);
    if (r.id) a.channels.push({ id: r.id, channelId: r.channel_id, title: r.title, status: r.status });
  }
  return [...out.values()];
}

// ---- Quota guard ----
/**
 * Atomically adds the call's cost to today's (Pacific) counter ONLY if it stays within `budget`. Returns false (and counts
 * nothing) when it would go over. Skeleton: callers of the YouTube API reserve before the call.
 */
export async function reserveQuota(db: Pick<pg.Pool, "query">, call: QuotaCall, opts: { budget?: number; now?: Date } = {}): Promise<boolean> {
  const cost = quotaCost(call);
  const budget = opts.budget ?? DEFAULT_QUOTA_BUDGET;
  if (cost > budget) return false;
  const r = await db.query(
    `insert into quota_usage (day, units) values ($1, $2)
     on conflict (day) do update set units = quota_usage.units + $2 where quota_usage.units + $2 <= $3 returning units`,
    [quotaDay(opts.now ?? new Date()), cost, budget],
  );
  return (r.rowCount ?? 0) > 0;
}
