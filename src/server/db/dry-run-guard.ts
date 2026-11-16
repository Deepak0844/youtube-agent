import type pg from "pg";
import { listProviderKeys } from "@/server/db/provider-keys";

/**
 * Fake providers must never run against a database that holds real data or a real provider key. NODE_ENV alone is not enough
 * (a tsx worker often has it unset), so the dry run needs ALL of:
 *   - ENGINE_DRY_RUN=1 and NODE_ENV not "production";
 *   - a positive marker that this is a throwaway database: its name ends in _dev or _test, or ENGINE_DRY_RUN_DB_OK=1;
 *   - no provider key stored in the vault.
 * Returns the plain reason to refuse, or null when the dry run may start.
 */
export async function dryRunRefusal(db: pg.Pool, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (env.ENGINE_DRY_RUN !== "1") return "Set ENGINE_DRY_RUN=1. The dry run makes fake videos and must never start by accident.";
  if (env.NODE_ENV === "production") return "The dry run is refused in production.";
  const name = (await db.query<{ n: string }>("select current_database() as n")).rows[0]!.n;
  if (env.ENGINE_DRY_RUN_DB_OK !== "1" && !/_(dev|test)$/.test(name)) {
    return `The dry run needs a throwaway database: "${name}" does not end in _dev or _test. Set ENGINE_DRY_RUN_DB_OK=1 only if you are sure it holds nothing real.`;
  }
  const keys = (await listProviderKeys(db)).filter((k) => k.isSet);
  if (keys.length > 0) return "A provider key is stored in this database, so it is not a throwaway one. The dry run is refused.";
  return null;
}
