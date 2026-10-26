import { bootstrapRoles } from "@/server/db/bootstrap";
import { migrate } from "@/server/db/migrate";
import { createPool } from "@/server/db/pool";

// migrate.ts uses import.meta (ESM-only), which Playwright's CJS transform of global-setup cannot load, so global-setup
// runs this file through tsx instead. Creates both roles (superuser URL in BOOTSTRAP_DATABASE_URL), then migrates as the
// owner (MIGRATE_DATABASE_URL), exactly like production.
const sup = createPool(process.env.BOOTSTRAP_DATABASE_URL!);
try {
  await bootstrapRoles(sup, { ownerPassword: process.env.YTSTUDIO_OWNER_PASSWORD!, appPassword: process.env.YTSTUDIO_APP_PASSWORD! });
} finally {
  await sup.end();
}
const pool = createPool(process.env.MIGRATE_DATABASE_URL!);
try {
  await migrate(pool);
} finally {
  await pool.end();
}
