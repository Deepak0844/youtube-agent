import { getMigratePool, getPool } from "@/server/db/pool";
import { loadKeyring } from "@/server/db/master-key";
import { rewrapAll } from "@/server/db/vault";

// Rotation: put the NEW key in VAULT_MASTER_KEY and the OLD one in VAULT_MASTER_KEY_PREVIOUS, run this, then drop
// the previous key. Re-encrypts every row sealed by another key. Names (never values) of unreadable rows are listed.
async function main(): Promise<void> {
  let ring;
  try {
    ring = loadKeyring();
  } catch {
    process.stderr.write("missing_key: VAULT_MASTER_KEY is absent or malformed in .env.local.\n");
    process.exitCode = 1;
    return;
  }
  if (!process.env.DATABASE_URL && !process.env.MIGRATE_DATABASE_URL) {
    process.stderr.write("failed: no DATABASE_URL configured\n");
    process.exitCode = 1;
    return;
  }
  const pool = process.env.DATABASE_URL ? getPool() : getMigratePool();
  try {
    const r = await rewrapAll(pool, ring);
    process.stdout.write(`rewrapped ${r.rewrapped} secret(s) to key ${ring.current.id}\n`);
    if (r.unreadable.length > 0) {
      process.stderr.write(`unreadable: ${r.unreadable.length} secret(s) could not be decrypted with the loaded keys: ${r.unreadable.join(", ")}\n`);
      process.exitCode = 1;
    }
  } finally {
    await pool.end().catch(() => {});
  }
}
main().catch((err: unknown) => {
  process.stderr.write(`failed: ${err instanceof Error ? err.constructor.name : "unknown error"}\n`);
  process.exitCode = 1;
});
