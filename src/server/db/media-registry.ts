import type pg from "pg";
import { isPriced, type PriceRule } from "@/server/core/media-catalog";

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
