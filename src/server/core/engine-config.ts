import { SETTINGS, parseSetting, type SettingKey } from "./settings-registry";

export interface QaTrack {
  width: number;
  height: number;
  minS: number;
  maxS: number;
}
export interface EngineConfig {
  retryAttempts: number;
  retryBackoffSeconds: readonly number[];
  timeoutStageS: number;
  timeoutAuthorS: number;
  timeoutLiveS: number;
  leaseS: number;
  heartbeatS: number;
  logCapBytes: number;
  cheapTextRunBudgetMicroUsd: number;
  breaker: { threshold: number; cooldownS: number; stages: readonly string[] };
  uploadsConcurrent: number;
  qa: { short: QaTrack; long: QaTrack; meanDbMin: number; peakDbMax: number; loopDiffMax: number; durationToleranceS: number };
  render: { timeoutS: number; cpus: number; memoryMb: number; pids: number };
}

export const ENGINE_KEYS = (Object.keys(SETTINGS) as SettingKey[]).filter((k) => /^(engine|breaker|qa|render)\./.test(k) || k === "uploads.concurrent");

/**
 * Builds the config from stored values. A key with no stored value uses its default; a stored value that is invalid
 * THROWS (a corrupt cap must stop the engine, not silently become the default).
 */
export function buildEngineConfig(stored: ReadonlyMap<string, unknown>): EngineConfig {
  const get = <T>(key: SettingKey): T => {
    if (!stored.has(key)) return SETTINGS[key].default as T;
    try {
      return parseSetting(key, stored.get(key)) as T;
    } catch (err) {
      throw new Error(`invalid stored setting ${key}: ${(err as Error).message}`);
    }
  };
  const c: EngineConfig = {
    retryAttempts: get("engine.retry_attempts"),
    retryBackoffSeconds: get("engine.retry_backoff_seconds"),
    timeoutStageS: get("engine.timeout_stage_s"),
    timeoutAuthorS: get("engine.timeout_author_s"),
    timeoutLiveS: get("engine.timeout_live_s"),
    leaseS: get("engine.lease_s"),
    heartbeatS: get("engine.heartbeat_s"),
    logCapBytes: get("engine.log_cap_bytes"),
    cheapTextRunBudgetMicroUsd: get("engine.cheap_text_run_budget_micro_usd"),
    breaker: { threshold: get("breaker.threshold"), cooldownS: get("breaker.cooldown_s"), stages: get("breaker.stages") },
    uploadsConcurrent: get("uploads.concurrent"),
    qa: {
      short: { width: get("qa.width"), height: get("qa.height"), minS: get("qa.min_s"), maxS: get("qa.max_s") },
      long: { width: get("qa.long_width"), height: get("qa.long_height"), minS: get("qa.long_min_s"), maxS: get("qa.long_max_s") },
      meanDbMin: get("qa.mean_db_min"),
      peakDbMax: get("qa.peak_db_max"),
      loopDiffMax: get("qa.loop_diff_max"),
      durationToleranceS: get("qa.duration_tolerance_s"),
    },
    render: { timeoutS: get("render.timeout_s"), cpus: get("render.cpus"), memoryMb: get("render.memory_mb"), pids: get("render.pids") },
  };
  // Same cross-checks as the old config.py validate().
  if (c.leaseS <= c.heartbeatS * 2) throw new Error("engine.lease_s must be more than twice engine.heartbeat_s");
  if (c.retryBackoffSeconds.length < c.retryAttempts - 1) throw new Error("engine.retry_backoff_seconds needs one entry per retry (attempts - 1)");
  if (c.qa.short.minS > c.qa.short.maxS || c.qa.long.minS > c.qa.long.maxS) throw new Error("qa min seconds must not exceed max seconds");
  return c;
}
