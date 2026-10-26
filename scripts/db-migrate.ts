import { migrate } from "@/server/db/migrate";
import { loadKeyring } from "@/server/db/master-key";
import { getMigratePool } from "@/server/db/pool";
import { runTotpBackfill } from "@/server/db/totp-backfill";

// Runs pending migrations as the owner role (MIGRATE_DATABASE_URL). The web app never migrates.
async function main(): Promise<void> {
  try {
    const pool = getMigratePool();
    try {
      await migrate(pool);
      process.stdout.write("migrations up to date\n");
      const b = await runTotpBackfill(pool, () => loadKeyring());
      (b.exitCode === 0 ? process.stdout : process.stderr).write(b.message);
      if (b.exitCode !== 0) process.exitCode = b.exitCode;
    } finally {
      await pool.end().catch(() => {});
    }
  } catch (err) {
    process.stderr.write(`failed: ${err instanceof Error ? err.message : "unknown error"}\n`);
    process.exitCode = 1;
  }
}
void main();
