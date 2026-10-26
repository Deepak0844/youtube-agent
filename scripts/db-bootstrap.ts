import { bootstrapRoles } from "@/server/db/bootstrap";
import { createPool } from "@/server/db/pool";

// Usage: BOOTSTRAP_DATABASE_URL=<superuser url of the target db> YTSTUDIO_OWNER_PASSWORD=... YTSTUDIO_APP_PASSWORD=... npm run db:bootstrap
async function main(): Promise<void> {
  const url = process.env.BOOTSTRAP_DATABASE_URL;
  const ownerPassword = process.env.YTSTUDIO_OWNER_PASSWORD;
  const appPassword = process.env.YTSTUDIO_APP_PASSWORD;
  if (!url || !ownerPassword || !appPassword) {
    process.stderr.write("BOOTSTRAP_DATABASE_URL, YTSTUDIO_OWNER_PASSWORD and YTSTUDIO_APP_PASSWORD must be set\n");
    process.exitCode = 1;
    return;
  }
  const pool = createPool(url);
  try {
    await bootstrapRoles(pool, { ownerPassword, appPassword });
    process.stdout.write("roles ytstudio_owner and ytstudio_app are ready\n");
  } catch (err) {
    process.stderr.write(`failed: ${err instanceof Error ? err.message : "unknown error"}\n`);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}
void main();
