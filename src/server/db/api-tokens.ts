import type pg from "pg";
import { generateToken, hashesEqual, hashToken, prefixOf, type NewTokenInput, type TokenScope } from "@/server/core/api-token";
import { createVideoRow, type VideoRow } from "@/server/db/videos";

export interface ApiTokenRow {
  id: string;
  name: string;
  prefix: string;
  scopes: TokenScope[];
  dailyDraftCap: number;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  draftsToday: number;
}

const IST_DAY = "(now() at time zone 'Asia/Kolkata')::date";

/** Creates a token. The secret is returned ONCE here and never stored; only its hash is. */
export async function createApiToken(db: pg.Pool, i: NewTokenInput): Promise<{ id: string; secret: string; prefix: string }> {
  const t = generateToken();
  const r = await db.query<{ id: string }>(
    "insert into api_tokens (name, prefix, token_hash, scopes, daily_draft_cap) values ($1,$2,$3,$4,$5) returning id",
    [i.name, t.prefix, t.hash, i.scopes, i.dailyDraftCap],
  );
  return { id: r.rows[0]!.id, secret: t.secret, prefix: t.prefix };
}

export async function listApiTokens(db: pg.Pool): Promise<ApiTokenRow[]> {
  const r = await db.query(
    `select t.id, t.name, t.prefix, t.scopes, t.daily_draft_cap, t.created_at, t.last_used_at, t.revoked_at, coalesce(u.drafts, 0) as drafts_today
       from api_tokens t left join api_token_usage u on u.token_id = t.id and u.day = ${IST_DAY}
      order by t.created_at desc, t.id desc limit 200`,
  );
  return r.rows.map((x) => ({ id: x.id, name: x.name, prefix: x.prefix, scopes: x.scopes, dailyDraftCap: x.daily_draft_cap, createdAt: x.created_at, lastUsedAt: x.last_used_at, revokedAt: x.revoked_at, draftsToday: x.drafts_today }));
}

/** Returns the token's name and prefix when it was active and is now revoked; null when missing or already revoked. */
export async function revokeApiToken(db: pg.Pool, id: string): Promise<{ name: string; prefix: string } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const r = await db.query<{ name: string; prefix: string }>("update api_tokens set revoked_at = now() where id = $1 and revoked_at is null returning name, prefix", [id]);
  return r.rows[0] ?? null;
}

export interface AuthedToken {
  id: string;
  name: string;
  scopes: TokenScope[];
  dailyDraftCap: number;
}

/**
 * Finds the active token for a presented secret. Rows are found by the public prefix; the hash is then compared in constant
 * time (also against itself when nothing matched, so a miss costs the same). Revoked tokens never authenticate.
 */
export async function authenticateToken(db: pg.Pool, secret: string): Promise<AuthedToken | null> {
  const presented = hashToken(secret);
  const r = await db.query("select id, name, scopes, daily_draft_cap, token_hash, revoked_at from api_tokens where prefix = $1 limit 20", [prefixOf(secret)]);
  let hit: (typeof r.rows)[number] | null = null;
  for (const row of r.rows) if (hashesEqual(presented, row.token_hash as Buffer) && hit === null) hit = row;
  if (r.rows.length === 0) hashesEqual(presented, presented);
  if (hit === null || hit.revoked_at !== null) return null;
  await db.query("update api_tokens set last_used_at = now() where id = $1", [hit.id]);
  return { id: hit.id, name: hit.name, scopes: hit.scopes, dailyDraftCap: hit.daily_draft_cap };
}

export type DraftResult = { ok: true; video: VideoRow } | { ok: false; reason: "cap_reached" };

/**
 * Creates one draft video for a token, counting it against the token's cap for the current IST day. The count and the video
 * are one transaction, and the count is one atomic upsert, so parallel calls can never pass the cap. A token revoked after it
 * authenticated creates nothing.
 */
export async function createDraftForToken(db: pg.Pool, token: AuthedToken, draft: { topic: string; notes?: string | null }): Promise<DraftResult> {
  const c = await db.connect();
  try {
    await c.query("begin");
    const u = await c.query(
      `insert into api_token_usage (token_id, day, drafts)
         select t.id, ${IST_DAY}, 1 from api_tokens t where t.id = $1 and t.revoked_at is null and t.daily_draft_cap >= 1
       on conflict (token_id, day) do update set drafts = api_token_usage.drafts + 1
         where api_token_usage.drafts < (select daily_draft_cap from api_tokens where id = $1) and exists (select 1 from api_tokens where id = $1 and revoked_at is null)
       returning drafts`,
      [token.id],
    );
    if (u.rowCount === 0) {
      await c.query("rollback");
      return { ok: false, reason: "cap_reached" };
    }
    const video = await createVideoRow(c, { format: "short", kind: "scene_kit", language: "en", topic: draft.topic, notes: draft.notes ?? null });
    await c.query("commit");
    return { ok: true, video };
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export async function statusCounts(db: pg.Pool): Promise<Record<string, number>> {
  const r = await db.query<{ status: string; n: string }>("select status, count(*)::text n from videos group by status");
  return Object.fromEntries(r.rows.map((x) => [x.status, Number(x.n)]));
}
