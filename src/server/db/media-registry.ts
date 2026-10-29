import type pg from "pg";
import { KEY_SLOT, canEnable, canRoute, isPriced, routeScope, type PriceRule } from "@/server/core/media-catalog";
import { secretName, type ProviderId } from "@/server/core/provider-keys";
import { recordAudit } from "@/server/db/audit";
import { atomic } from "@/server/db/stages";

type Db = pg.Pool | pg.PoolClient;

/** The provider's price rule, or null when the provider is unknown, disabled or unpriced (all refused). */
export async function getPriceRule(db: Db, providerId: string): Promise<PriceRule | null> {
  const { rows } = await db.query<{ price: unknown }>("select price from media_providers where id = $1 and enabled", [providerId]);
  return rows[0] && isPriced(rows[0].price) ? rows[0].price : null;
}

/** Most specific route wins: video kind, then format, then default. No route means null, never a default provider. */
export async function resolveRoute(
  db: Db,
  kind: string,
  { format, videoKind }: { format: string; videoKind: string },
): Promise<{ provider: string; voice?: string; model?: string } | null> {
  const { rows } = await db.query<{ provider: string; voice: string | null; model: string | null }>(
    `select provider, voice, model from media_routes
     where kind = $1 and scope in ($2, $3, 'default')
     order by case scope when $2 then 0 when $3 then 1 else 2 end limit 1`,
    [kind, `kind:${videoKind}`, `format:${format}`],
  );
  const r = rows[0];
  if (!r) return null;
  return { provider: r.provider, ...(r.voice && { voice: r.voice }), ...(r.model && { model: r.model }) };
}

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

export interface ProviderRow {
  id: string;
  kind: string;
  label: string;
  enabled: boolean;
  local: boolean;
  commercialUse: string;
  wordTimings: string | null;
  languages: string[];
  price: unknown;
  hasKey: boolean;
}
export interface RouteRow {
  kind: string;
  scope: string;
  provider: string;
  voice: string | null;
}

export async function listProviders(db: Db): Promise<ProviderRow[]> {
  const { rows } = await db.query<Omit<ProviderRow, "hasKey">>(
    `select id, kind, label, enabled, local, commercial_use as "commercialUse", word_timings as "wordTimings", languages, price
     from media_providers order by kind, label`,
  );
  const names = rows.flatMap((r) => (KEY_SLOT[r.id] ? [secretName(KEY_SLOT[r.id] as ProviderId)] : []));
  const have = new Set((await db.query<{ name: string }>("select name from secrets where name = any($1::text[])", [names])).rows.map((r) => r.name));
  return rows.map((r) => ({ ...r, hasKey: KEY_SLOT[r.id] ? have.has(secretName(KEY_SLOT[r.id] as ProviderId)) : false }));
}

export async function listRoutes(db: Db): Promise<RouteRow[]> {
  return (await db.query<RouteRow>("select kind, scope, provider, voice from media_routes order by kind, scope")).rows;
}

function assertSession(actor: string): void {
  if (actor !== "session") throw new RegistryError("Only a signed-in session can change providers and routes.");
}

/** Session only. Enabling needs a saved key unless the provider is free or local. One audit row. */
export async function setProviderEnabled(db: pg.Pool, id: string, enabled: boolean, actor: "session" | "token" | "system"): Promise<void> {
  assertSession(actor);
  await atomic(db, async (q) => {
    const { rows } = await q.query<{ price: unknown; local: boolean }>("select price, local from media_providers where id = $1 for update", [id]);
    if (!rows[0]) throw new RegistryError("Unknown provider.");
    if (enabled) {
      const slot = KEY_SLOT[id];
      const hasKey = slot ? ((await q.query("select 1 from secrets where name = $1", [secretName(slot as ProviderId)])).rowCount ?? 0) > 0 : false;
      const ok = canEnable(rows[0], hasKey);
      if (!ok.ok) throw new RegistryError(ok.reason);
    }
    await q.query("update media_providers set enabled = $2, updated_at = now() where id = $1", [id, enabled]);
    await recordAudit(q as pg.PoolClient, "provider.toggled", { provider: id, enabled });
  });
}

/** Session only. The target must be switched on and priced; the route's kind is the provider's. `voice` is kept for voice routes only. One audit row. */
export async function setMediaRoute(db: pg.Pool, r: { scope: string; provider: string; voice?: string }, actor: "session" | "token" | "system"): Promise<void> {
  assertSession(actor);
  if (routeScope(r.scope) === null) throw new RegistryError("Unknown route.");
  const voice = r.voice?.trim() || null;
  if (voice && voice.length > 100) throw new RegistryError("The voice name is too long.");
  await atomic(db, async (q) => {
    const { rows } = await q.query<{ kind: string; enabled: boolean; price: unknown }>("select kind, enabled, price from media_providers where id = $1 for share", [r.provider]);
    if (!rows[0]) throw new RegistryError("Unknown provider.");
    const kind = rows[0].kind;
    if (kind !== "voice" && voice) throw new RegistryError("Only voice providers have a narration voice.");
    const ok = canRoute(rows[0]);
    if (!ok.ok) throw new RegistryError(ok.reason);
    const prev = await q.query<{ provider: string }>("select provider from media_routes where kind = $1 and scope = $2 for update", [kind, r.scope]);
    await q.query(
      `insert into media_routes (kind, scope, provider, voice) values ($1, $2, $3, $4)
       on conflict (kind, scope) do update set provider = excluded.provider, voice = excluded.voice`,
      [kind, r.scope, r.provider, voice],
    );
    await recordAudit(q as pg.PoolClient, "route.changed", { kind, scope: r.scope, from: prev.rows[0]?.provider ?? null, to: r.provider, voice });
  });
}
