import { describe, expect, it } from "vitest";
import { ENGINE_KEYS } from "@/server/core/engine-config";
import { BUDGET_DEFAULTS, SETTINGS, SAFETY_KEYS, parseSetting } from "@/server/core/settings-registry";

describe("settings registry", () => {
  it("every_default_passes_its_own_schema", () => {
    for (const [key, def] of Object.entries(SETTINGS)) {
      expect(def.schema.safeParse(def.default).success, key).toBe(true);
      expect(def.label.length, key).toBeGreaterThan(0);
    }
  });

  it("unknown_key_refused", () => {
    expect(() => parseSetting("nope.nothing", 1)).toThrow(/unknown setting/);
  });

  it("invalid_values_refused", () => {
    expect(() => parseSetting("jobs.concurrent_renders", -1)).toThrow();
    expect(() => parseSetting("jobs.concurrent_renders", 1.5)).toThrow();
    expect(() => parseSetting("storage.warn_gb", 0)).toThrow();
    expect(() => parseSetting("policy.allow_public", "yes")).toThrow();
    expect(() => parseSetting("display.currency", "")).toThrow();
  });

  it("safety_keys_are_exactly_the_reviewed_list", () => {
    expect([...SAFETY_KEYS].sort()).toEqual(
      [
        "network.local_services", "policy.allow_public", "policy.require_evidence",
        "assets.max_image_bytes", "assets.max_audio_bytes", "assets.max_pixels", "assets.max_batch_files", "assets.total_bytes_cap",
        "assets.retention_days", "assets.unused_days", "assets.trash_days", "voice.local_url", "voice.voicestudio_url",
        "claude_code.enabled", "claude_code.daily_cap",
        ...ENGINE_KEYS,
      ].sort(),
    );
  });

  it("defaults_match_doc_02_and_07", () => {
    const d = Object.fromEntries(Object.entries(SETTINGS).filter(([k]) => !ENGINE_KEYS.includes(k as never) && !k.startsWith("notify.")).map(([k, v]) => [k, v.default]));
    expect(d).toEqual({
      "jobs.concurrent_renders": 1,
      "jobs.concurrent_jobs": 2,
      "storage.warn_gb": 50,
      "assets.max_image_bytes": 26_214_400,
      "assets.max_audio_bytes": 209_715_200,
      "assets.max_pixels": 50_000_000,
      "assets.max_batch_files": 100,
      "assets.total_bytes_cap": 5_368_709_120,
      "assets.retention_days": 7,
      "assets.unused_days": 30,
      "assets.trash_days": 7,
      "video.max_long_minutes": 15,
      "tracks.enabled": { scene_kit: true, tsx: true, collage: true, ai: true },
      "policy.require_evidence": true,
      "policy.allow_public": false,
      "network.local_services": [],
      "voice.azure_region": "",
      "voice.local_url": "",
      "voice.voicestudio_url": "",
      "claude_code.enabled": false,
      "claude_code.daily_cap": 200,
      "display.currency": "USD",
    });
  });

  it("budget_defaults_equal_doc_02_4_5_in_micro_usd", () => {
    expect(BUDGET_DEFAULTS).toEqual({
      "video:scene_kit": 2_000_000,
      "video:tsx": 5_000_000,
      "video:collage": 5_000_000,
      "video:ai": 15_000_000,
      "video:long": 8_000_000,
      day: 15_000_000,
      month: 100_000_000,
      draft_run: 3_000_000,
    });
  });
});
