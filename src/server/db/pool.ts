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
