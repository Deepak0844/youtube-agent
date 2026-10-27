import type pg from "pg";
import { buildEngineConfig, ENGINE_KEYS, type EngineConfig } from "@/server/core/engine-config";
import { SETTINGS, parseSetting } from "@/server/core/settings-registry";
import { getStoredSettings } from "@/server/db/settings";

/** Reads every engine setting in one query. Missing row = default; invalid row = throws. Read-only: writes stay session-only. */
export async function getEngineConfig(db: pg.Pool | pg.PoolClient): Promise<EngineConfig> {
  return buildEngineConfig(await getStoredSettings(db, ENGINE_KEYS));
}

export interface WorkerSettings { config: EngineConfig; concurrentJobs: number; concurrentRenders: number }

/** Engine config plus the worker admission limits, from one read-only snapshot. */
export async function getWorkerSettings(db: pg.Pool): Promise<WorkerSettings> {
  const keys = ["jobs.concurrent_jobs", "jobs.concurrent_renders"] as const;
  const stored = await getStoredSettings(db, [...ENGINE_KEYS, ...keys]);
  const concurrency = (key: typeof keys[number]) => parseSetting(key, stored.has(key) ? stored.get(key) : SETTINGS[key].default) as number;
  return { config: buildEngineConfig(stored), concurrentJobs: concurrency(keys[0]), concurrentRenders: concurrency(keys[1]) };
}
