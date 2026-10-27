import pg from "pg";

const forceClosers = new WeakMap<pg.Pool, () => void>();

// bigint columns (fence, micro-USD) arrive as strings from pg; callers convert explicitly.
// An error on an idle client (server restart, network drop) is emitted on the pool; without a listener it would
// crash the process. We log one JSON line and carry on; the pool drops that client.
// No global statement_timeout on purpose (ruling): long legitimate transactions exist.
export function createPool(url: string, opts: { connectionTimeoutMillis?: number } = {}): pg.Pool {
  const pool = new pg.Pool({ connectionString: url, max: 10, connectionTimeoutMillis: opts.connectionTimeoutMillis ?? 15_000 });
  const clients = new Set<pg.PoolClient>();
  let forced = false;
  const disconnect = (client: pg.PoolClient) => { void client.end().catch(() => {}); };
  pool.on("connect", (client) => {
    clients.add(client);
    client.once("end", () => clients.delete(client));
    if (forced) disconnect(client);
  });
  forceClosers.set(pool, () => { forced = true; for (const client of clients) disconnect(client); });
  pool.on("error", (err) => {
    console.error(JSON.stringify({ event: "pg.pool_idle_client_error", error: String(err?.message ?? err).slice(0, 500) }));
  });
  return pool;
}

// Only clients belonging to a pool created here are terminated. Public pg Client.end() disconnects an active
// non-pipelined query; no owner role, backend-termination SQL or private pg-pool internals are required.
export function forceClosePool(pool: pg.Pool): void {
  forceClosers.get(pool)?.();
}

// One pool per Node process for the Next runtime. Cached on globalThis so dev HMR re-evaluating this module does not leak
// pools. Migrations are NOT run here (CLI / e2e global-setup do that).
const KEY = Symbol.for("ytstudio.pool");
export function getPool(): pg.Pool {
  const g = globalThis as unknown as Record<symbol, pg.Pool | undefined>;
  const cached = g[KEY];
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set; the web app cannot reach Postgres");
  return (g[KEY] = createPool(url));
}

// Owner-role pool for migrations and maintenance CLIs (audit retention deletes). Not cached: callers end() it.
export function getMigratePool(): pg.Pool {
  const url = process.env.MIGRATE_DATABASE_URL;
  if (!url) throw new Error("MIGRATE_DATABASE_URL is not set; migrations and maintenance run as the owner role");
  return createPool(url);
}
