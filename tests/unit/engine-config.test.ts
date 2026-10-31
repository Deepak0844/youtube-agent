import { describe, expect, it } from "vitest";
import type pg from "pg";
import { SETTINGS, SAFETY_KEYS } from "@/server/core/settings-registry";
import { buildEngineConfig, ENGINE_KEYS } from "@/server/core/engine-config";
import { getEngineConfig } from "@/server/db/engine-config";

const d = (k: string) => (SETTINGS as Record<string, { default: unknown }>)[k]!.default;

describe("engine numbers", () => {
  it("every new key is registered, safety, and in the safety list", () => {
    expect(ENGINE_KEYS.length).toBeGreaterThan(20);
    for (const k of ENGINE_KEYS) {
      expect(Object.hasOwn(SETTINGS, k), k).toBe(true);
      expect(SAFETY_KEYS as string[], k).toContain(k);
    }
  });

  it("defaults equal Doc 2 4.7 and the old config.py / qa.py numbers", () => {
    const c = buildEngineConfig(new Map());
    expect(c).toEqual({
      retryAttempts: 3,
      retryBackoffSeconds: [30, 120, 480],
      timeoutStageS: 1800,
      timeoutAuthorS: 2400,
      timeoutLiveS: 43200,
      leaseS: 60,
      heartbeatS: 5,
      logCapBytes: 5_000_000,
      cheapTextRunBudgetMicroUsd: 50_000,
      breaker: { threshold: 3, cooldownS: 900, stages: ["draft", "build", "voice"] },
      uploadsConcurrent: 1,
      qa: {
        short: { width: 1080, height: 1920, minS: 15, maxS: 60 },
        long: { width: 1920, height: 1080, minS: 180, maxS: 900 },
        meanDbMin: -40,
        peakDbMax: -0.3,
        loopDiffMax: 14,
        durationToleranceS: 1.5,
      },
      render: { timeoutS: 600, cpus: 4, memoryMb: 4096, pids: 512 },
    });
    expect(d("engine.retry_backoff_seconds")).toEqual([30, 120, 480]);
  });

  it("an invalid stored value throws and is never replaced by the default", () => {
    expect(() => buildEngineConfig(new Map([["engine.retry_attempts", 0]]))).toThrow(/engine\.retry_attempts/);
    expect(() => buildEngineConfig(new Map([["engine.lease_s", "60"]]))).toThrow(/engine\.lease_s/);
  });

  it("render limits are bounded so a setting cannot remove the sandbox ceiling", () => {
    expect(() => buildEngineConfig(new Map([["render.memory_mb", 1_000_000]]))).toThrow(/render\.memory_mb/);
    expect(() => buildEngineConfig(new Map([["render.timeout_s", 0]]))).toThrow(/render\.timeout_s/);
    expect(buildEngineConfig(new Map([["render.cpus", 2]])).render.cpus).toBe(2);
  });

  it("refuses numbers that contradict each other", () => {
    expect(() => buildEngineConfig(new Map([["engine.lease_s", 10]]))).toThrow(/lease/);
    expect(() => buildEngineConfig(new Map([["engine.retry_attempts", 5]]))).toThrow(/back-?off/i);
  });

  it("reads settings once and falls back to defaults only for a missing row", async () => {
    let calls = 0;
    const db = { query: async () => (calls++, { rows: [{ key: "engine.lease_s", value: 90 }] }) } as unknown as pg.Pool;
    const c = await getEngineConfig(db);
    expect(calls).toBe(1);
    expect(c.leaseS).toBe(90);
    expect(c.heartbeatS).toBe(5);
  });
});
