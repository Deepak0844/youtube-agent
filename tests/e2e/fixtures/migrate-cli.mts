import { migrate } from "@/server/db/migrate";
import { createPool } from "@/server/db/pool";

// migrate.ts uses import.meta (ESM-only), which Playwright's CJS transform of global-setup cannot load, so global-setup
// runs this file through tsx instead.
const pool = createPool(process.env.DATABASE_URL!);
try {
  await migrate(pool);
} finally {
  await pool.end();
}
