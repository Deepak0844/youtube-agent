import { migrate } from "@/server/db/migrate";
import { getMigratePool } from "@/server/db/pool";

// Runs pending migrations as the owner role (MIGRATE_DATABASE_URL). The web app never migrates.
async function main(): Promise<void> {
  try {
    const pool = getMigratePool();
    try {
      await migrate(pool);
      process.stdout.write("migrations up to date\n");
    } finally {
      await pool.end().catch(() => {});
    }
  } catch (err) {
    process.stderr.write(`failed: ${err instanceof Error ? err.message : "unknown error"}\n`);
    process.exitCode = 1;
  }
}
void main();
