import type pg from "pg";
import { buildEngineConfig, ENGINE_KEYS, type EngineConfig } from "@/server/core/engine-config";
import { getStoredSettings } from "@/server/db/settings";

/** Reads every engine setting in one query. Missing row = default; invalid row = throws. Read-only: writes stay session-only. */
export async function getEngineConfig(db: pg.Pool | pg.PoolClient): Promise<EngineConfig> {
  return buildEngineConfig(await getStoredSettings(db, ENGINE_KEYS));
}
