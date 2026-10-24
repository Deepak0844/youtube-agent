import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
// Arbitrary constant; serialises concurrent migrators across processes.
const LOCK_KEY = 7_340_001;

// `connect` is a test seam; defaults to pool.connect.
export async function migrate(pool: pg.Pool, connect: () => Promise<pg.PoolClient> = () => pool.connect()): Promise<void> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const client = await connect();
  // If any session-state step fails (rollback/unlock), the connection may still hold the lock or an open txn: destroy it.
  let tainted = false;
  try {
    await client.query("select pg_advisory_lock($1)", [LOCK_KEY]).catch((err: unknown) => {
      tainted = true; // unknown whether the lock was taken
      throw err;
    });
    try {
      await client.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
      const { rows } = await client.query<{ name: string }>("select name from schema_migrations");
      const applied = new Set(rows.map((r) => r.name));
      for (const file of files) {
        if (applied.has(file)) continue;
        const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
        try {
          await client.query("begin");
          await client.query(sql);
          await client.query("insert into schema_migrations (name) values ($1)", [file]);
          await client.query("commit");
        } catch (err) {
          await client.query("rollback").catch(() => {
            tainted = true;
          });
          throw err;
        }
      }
    } finally {
      await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {
        tainted = true;
      });
    }
  } finally {
    client.release(tainted);
  }
}
