// Connecting YouTube channels through the owner's own Google app. Refresh tokens are written ONLY to the vault; the
// tables hold the vault entry name. Codes, tokens and the client secret are never logged or audited (audit rows carry
// channel ids and reasons only). Every Google call goes through the injected `GoogleHttp` (default: safeFetch), so tests use fakes.
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
  | { ok: false; reason: "state" | "no_app" | "bad_app_url" | "exchange" | "no_refresh_token" | "scopes" | "profile" | "no_channel" };

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
  if (missingScopes(scopes).length > 0) return { ok: false, reason: "scopes" };

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
  await reserveQuota(pool, "channels.list");

  const client = await pool.connect();
  try {
    await client.query("begin");
    const acct = await client.query<{ id: string }>(
      `insert into google_accounts (google_sub, email) values ($1, $2)
       on conflict (google_sub) do update set email = excluded.email returning id`,
      [sub, email],
    );
    for (const c of channels) {
      const name = channelSecretName(c.channelId);
      await putSecret(client, keyringOf(ring), name, refresh, { hint: false });
      // New -> unconfirmed. Reconnect keeps a confirmed channel confirmed (needs_reconnect -> connected).
      const r = await client.query<{ status: string }>(
        `insert into youtube_channels (google_account_id, channel_id, title, token_secret_name, scopes) values ($1, $2, $3, $4, $5)
         on conflict (channel_id) do update set google_account_id = excluded.google_account_id, title = excluded.title,
           token_secret_name = excluded.token_secret_name, scopes = excluded.scopes, updated_at = now(),
           status = case when youtube_channels.status = 'unconfirmed' then 'unconfirmed' else 'connected' end
         returning status`,
        [acct.rows[0]!.id, c.channelId, c.title, name, scopes],
      );
      await recordAudit(client, "youtube.channel_connected", { channelId: c.channelId, status: r.rows[0]!.status });
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

/** Deletes the channel row and its vault token in one transaction; drops a Google account left with no channels. */
export async function disconnectChannel(pool: pg.Pool, id: string, sessionId: string): Promise<boolean> {
  const client = await pool.connect();
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
    await client.query("delete from google_accounts a where a.id = $1 and not exists (select 1 from youtube_channels c where c.google_account_id = a.id)", [row.google_account_id]);
    await recordAudit(client, "youtube.channel_disconnected", { channelId: row.channel_id, sessionId });
    await client.query("commit");
    return true;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export type AccessResult = { ok: true; accessToken: string } | { ok: false; reason: "needs_reconnect" | "unavailable" };

/** Trades the vault refresh token for a short-lived access token (never stored). invalid_grant -> needs_reconnect + audit. */
export async function getAccessToken(pool: pg.Pool, ring: Ring, http: GoogleHttp, id: string): Promise<AccessResult> {
  const { rows } = await pool.query<{ channel_id: string; token_secret_name: string; status: string }>("select channel_id, token_secret_name, status from youtube_channels where id = $1", [id]);
  const ch = rows[0];
  if (!ch || ch.status === "needs_reconnect") return { ok: false, reason: ch ? "needs_reconnect" : "unavailable" };
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
    await pool.query("update youtube_channels set status = 'needs_reconnect', updated_at = now() where id = $1", [id]);
    await recordAudit(pool, "youtube.refresh_failed", { channelId: ch.channel_id, reason: "invalid_grant" });
    return { ok: false, reason: "needs_reconnect" };
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
