import pg from "pg";

// bigint columns (fence, micro-USD) arrive as strings from pg; callers convert explicitly.
// An error on an idle client (server restart, network drop) is emitted on the pool; without a listener it would
// crash the process. We log one JSON line and carry on; the pool drops that client.
// No global statement_timeout on purpose (ruling): long legitimate transactions exist.
export function createPool(url: string, opts: { connectionTimeoutMillis?: number } = {}): pg.Pool {
  const pool = new pg.Pool({ connectionString: url, max: 10, connectionTimeoutMillis: opts.connectionTimeoutMillis ?? 15_000 });
  pool.on("error", (err) => {
    console.error(JSON.stringify({ event: "pg.pool_idle_client_error", error: String(err?.message ?? err).slice(0, 500) }));
  });
  return pool;
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
