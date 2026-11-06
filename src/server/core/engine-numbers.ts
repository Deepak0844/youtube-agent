import { parseSetting, type SettingKey } from "./settings-registry";
import { buildEngineConfig } from "./engine-config";

// The engine numbers the owner may edit on /settings/system. The real range check is the registry schema (parseSetting);
// min/max here only feed the form hints and a unit test keeps them equal to the registry. All are safety keys.
export interface EngineNumberField {
  key: SettingKey;
  label: string;
  note: string;
  unit: string;
  min: number;
  max: number;
  /** "list" = comma-separated whole numbers (retry waits). */
  kind: "number" | "list";
}

export const ENGINE_NUMBER_FIELDS: readonly EngineNumberField[] = [
  { key: "engine.retry_attempts", label: "Tries per stage", note: "Total tries, first included. Also the crash re-claim limit.", unit: "tries", min: 1, max: 10, kind: "number" },
  { key: "engine.retry_backoff_seconds", label: "Wait before each retry", note: "Comma-separated seconds, one per retry (at least tries minus 1).", unit: "s", min: 1, max: 86_400, kind: "list" },
  { key: "engine.timeout_stage_s", label: "Stage time limit", note: "A stage running longer than this is stopped.", unit: "s", min: 10, max: 86_400, kind: "number" },
  { key: "engine.timeout_author_s", label: "Author stage time limit", note: "Same, for the AI-written scene stage.", unit: "s", min: 10, max: 86_400, kind: "number" },
  { key: "engine.timeout_live_s", label: "Live stage time limit", note: "Same, for stages that wait on a live stream.", unit: "s", min: 60, max: 172_800, kind: "number" },
  { key: "engine.lease_s", label: "Stage lease", note: "Must be more than twice the heartbeat.", unit: "s", min: 5, max: 3600, kind: "number" },
  { key: "engine.heartbeat_s", label: "Heartbeat", note: "How often a running stage reports it is alive.", unit: "s", min: 1, max: 600, kind: "number" },
  { key: "breaker.threshold", label: "Breaker: failures to trip", note: "Consecutive failures that pause a stage. 0 turns the breaker off.", unit: "failures", min: 0, max: 100, kind: "number" },
  { key: "breaker.cooldown_s", label: "Breaker cool-down", note: "How long a tripped stage stays paused.", unit: "s", min: 0, max: 86_400, kind: "number" },
  { key: "qa.min_s", label: "QA short: shortest", note: "Shorts under this length fail the check.", unit: "s", min: 1, max: 7200, kind: "number" },
  { key: "qa.max_s", label: "QA short: longest", note: "Shorts over this length fail the check.", unit: "s", min: 1, max: 7200, kind: "number" },
  { key: "qa.long_min_s", label: "QA long: shortest", note: "Long videos under this length fail the check.", unit: "s", min: 1, max: 86_400, kind: "number" },
  { key: "qa.long_max_s", label: "QA long: longest", note: "Long videos over this length fail the check.", unit: "s", min: 1, max: 86_400, kind: "number" },
  { key: "qa.mean_db_min", label: "QA quietest average", note: "Average loudness below this fails (more negative is more lenient).", unit: "dB", min: -100, max: 0, kind: "number" },
  { key: "qa.peak_db_max", label: "QA loudest peak", note: "Peaks above this fail (clipping guard).", unit: "dB", min: -20, max: 0, kind: "number" },
  { key: "qa.loop_diff_max", label: "QA loop seam difference", note: "Largest allowed jump between last and first frame (of 255).", unit: "of 255", min: 0.1, max: 255, kind: "number" },
  { key: "qa.duration_tolerance_s", label: "QA length tolerance", note: "Allowed gap between planned and real length.", unit: "s", min: 0.1, max: 60, kind: "number" },
];

export const ENGINE_NUMBER_KEYS: readonly string[] = ENGINE_NUMBER_FIELDS.map((f) => f.key);

export type EngineNumberResult = { ok: true; values: Array<{ key: SettingKey; value: unknown }> } | { ok: false; error: string };

/**
 * Parses the form (key -> text) against the registry ranges, then runs the engine's cross-checks on the merged result,
 * so a save the engine would refuse to load is refused here. `current` holds the stored engine values.
 */
export function parseEngineNumbers(input: Record<string, unknown>, current: ReadonlyMap<string, unknown>): EngineNumberResult {
  const values: Array<{ key: SettingKey; value: unknown }> = [];
  for (const f of ENGINE_NUMBER_FIELDS) {
    const raw = input[f.key];
    if (typeof raw !== "string" || raw.trim() === "" || raw.length > 200) return { ok: false, error: `${f.label}: enter a value.` };
    const parts = raw.split(",").map((s) => s.trim());
    if (f.kind === "number" && parts.length !== 1) return { ok: false, error: `${f.label}: enter one number.` };
    if (parts.some((p) => !/^-?\d+(\.\d+)?$/.test(p))) return { ok: false, error: `${f.label}: numbers only.` };
    const v = f.kind === "list" ? parts.map(Number) : Number(parts[0]);
    try {
      values.push({ key: f.key, value: parseSetting(f.key, v) });
    } catch {
      return { ok: false, error: `${f.label}: must be between ${f.min} and ${f.max}.` };
    }
  }
  try {
    buildEngineConfig(new Map([...current, ...values.map((x) => [x.key, x.value] as const)]));
  } catch (err) {
    return { ok: false, error: (err as Error).message.replace(/^invalid stored setting [\w.]+: /, "") };
  }
  return { ok: true, values };
}
