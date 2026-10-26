import { readFile } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";

// Creates ytstudio_owner (runs migrations, owns objects) and ytstudio_app (runtime, least privilege). Needs a SUPERUSER pool
// on the target database. Idempotent; re-running also rotates both passwords.
const SQL_FILE = path.join(process.cwd(), "infra", "db-bootstrap.sql");

export async function bootstrapRoles(superPool: pg.Pool, pw: { ownerPassword: string; appPassword: string }): Promise<void> {
  if (!pw.ownerPassword || !pw.appPassword) throw new Error("both role passwords are required");
  const sql = await readFile(SQL_FILE, "utf8");
  const client = await superPool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('bootstrap.owner_pw', $1, true), set_config('bootstrap.app_pw', $2, true)", [pw.ownerPassword, pw.appPassword]);
    await client.query(sql);
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
