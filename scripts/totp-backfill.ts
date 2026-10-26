import { loadKeyring } from "@/server/db/master-key";
import { getMigratePool } from "@/server/db/pool";
import { runTotpBackfill } from "@/server/db/totp-backfill";

// Encrypts any plaintext TOTP secret into the vault. Idempotent. Runs as the owner role (MIGRATE_DATABASE_URL) and needs
// VAULT_MASTER_KEY only when a plaintext row exists.
async function main(): Promise<void> {
  const pool = getMigratePool();
  try {
    const r = await runTotpBackfill(pool, () => loadKeyring());
    (r.exitCode === 0 ? process.stdout : process.stderr).write(r.message);
    process.exitCode = r.exitCode;
  } finally {
    await pool.end().catch(() => {});
  }
}
main().catch((err: unknown) => {
  process.stderr.write(`failed: ${err instanceof Error ? err.constructor.name : "unknown error"}\n`);
  process.exitCode = 1;
});
