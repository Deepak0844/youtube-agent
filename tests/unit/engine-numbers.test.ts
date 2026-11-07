import { describe, expect, it } from "vitest";
import { ENGINE_NUMBER_FIELDS, parseEngineNumbers } from "@/server/core/engine-numbers";
import { SAFETY_KEYS, SETTINGS, parseSetting } from "@/server/core/settings-registry";
import { buildEngineConfig } from "@/server/core/engine-config";

const text = (v: unknown) => [v].flat().join(",");
const defaults = () => Object.fromEntries(ENGINE_NUMBER_FIELDS.map((f) => [f.key, text(SETTINGS[f.key].default)]));
const none = new Map<string, unknown>();

describe("engine numbers", () => {
  it("defaults parse and build the same config as no stored values", () => {
    const r = parseEngineNumbers(defaults(), none);
    expect(r.ok).toBe(true);
    if (r.ok) expect(buildEngineConfig(new Map(r.values.map((v) => [v.key, v.value])))).toEqual(buildEngineConfig(none));
  });

  it("every field is a safety key and its min/max match the registry", () => {
    for (const f of ENGINE_NUMBER_FIELDS) {
      expect(SAFETY_KEYS as string[], f.key).toContain(f.key);
      const wrap = (v: number) => (f.kind === "list" ? [v] : v);
      expect(() => parseSetting(f.key, wrap(f.min)), `${f.key} min`).not.toThrow();
      expect(() => parseSetting(f.key, wrap(f.max)), `${f.key} max`).not.toThrow();
      expect(() => parseSetting(f.key, wrap(f.max + 1)), `${f.key} above max`).toThrow();
      expect(() => parseSetting(f.key, wrap(f.min - 1)), `${f.key} below min`).toThrow();
    }
  });

  it.each([
    ["engine.retry_attempts", "11"],
    ["engine.timeout_stage_s", "abc"],
    ["qa.peak_db_max", "5"],
    ["engine.retry_backoff_seconds", "30,,120"],
  ])("rejects %s = %s", (key, v) => {
    expect(parseEngineNumbers({ ...defaults(), [key]: v }, none).ok).toBe(false);
  });

  it("rejects a lease that is not over twice the heartbeat", () => {
    expect(parseEngineNumbers({ ...defaults(), "engine.lease_s": "10", "engine.heartbeat_s": "5" }, none).ok).toBe(false);
  });

  it("rejects fewer waits than retries", () => {
    expect(parseEngineNumbers({ ...defaults(), "engine.retry_attempts": "5", "engine.retry_backoff_seconds": "30" }, none).ok).toBe(false);
  });
});
