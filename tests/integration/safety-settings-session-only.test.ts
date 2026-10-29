import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTestDb, type TestDb } from "../support/db";
import { SAFETY_KEYS, SETTINGS, type SettingKey } from "@/server/core/settings-registry";
import { getSetting, setSetting, type Actor } from "@/server/db/settings";

// Database-level proof: no token / system / job actor changes a safety setting, the stored row is left untouched, and a
// session can. The unit twin (tests/unit/safety-settings-session-only.test.ts) proves the refusal happens before any DB
// access. There is no settings route in src/app yet; when /settings/* ships, add its HTTP case to
// tests/e2e/api/session-required.api.spec.ts (it is derived from the route table and will list the route automatically).
let db: TestDb;
beforeAll(async () => {
  db = await withTestDb();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
});

// A different, schema-valid value for each safety key, so a (wrongly) accepted write is observable.
const ALTERNATE: Record<string, unknown> = {
  "policy.require_evidence": false,
  "policy.allow_public": true,
  "network.local_services": ["localhost:11434"],
  "assets.max_image_bytes": 1_000_000,
  "assets.max_pixels": 1_000_000,
  "assets.max_batch_files": 10,
  "assets.total_bytes_cap": 1_000_000_000,
  "engine.retry_attempts": 2,
  "engine.retry_backoff_seconds": [1, 2, 3],
  "engine.timeout_stage_s": 99,
  "engine.timeout_author_s": 99,
  "engine.timeout_live_s": 99,
  "engine.lease_s": 99,
  "engine.heartbeat_s": 9,
  "engine.log_cap_bytes": 99,
  "engine.cheap_text_run_budget_micro_usd": 99,
  "breaker.threshold": 9,
  "breaker.cooldown_s": 99,
  "breaker.stages": ["draft"],
  "uploads.concurrent": 2,
  "qa.width": 720,
  "qa.height": 1280,
  "qa.min_s": 5,
  "qa.max_s": 99,
  "qa.mean_db_min": -50,
  "qa.peak_db_max": -1,
  "qa.loop_diff_max": 20,
  "qa.duration_tolerance_s": 3,
  "qa.long_width": 1280,
  "qa.long_height": 720,
  "qa.long_min_s": 60,
  "qa.long_max_s": 1200,
};

describe("safety settings are session-only (database)", () => {
  it("every safety key has an alternate value in this test (a new safety key must be added here)", () => {
    for (const k of SAFETY_KEYS) expect(ALTERNATE, k).toHaveProperty([k]);
  });

  for (const actor of ["token", "system", "job", "SESSION"]) {
    it(`actor "${actor}" is refused on every safety key and the stored value does not change`, async () => {
      for (const key of SAFETY_KEYS) {
        const before = await db.pool.query("select value, updated_by from settings where key = $1", [key]);
        await expect(setSetting(db.pool, key, ALTERNATE[key], { actor: actor as Actor }), key).rejects.toThrow(/logged-in session/);
        const after = await db.pool.query("select value, updated_by from settings where key = $1", [key]);
        expect(after.rows, key).toEqual(before.rows);
        expect(await getSetting(db.pool, key), key).toEqual(SETTINGS[key as SettingKey].default);
      }
    });
  }

  it("a session can write each safety key (control: the refusals above are about the actor, not the value)", async () => {
    for (const key of SAFETY_KEYS) {
      const r = await setSetting(db.pool, key, ALTERNATE[key], { actor: "session" });
      expect(r.new, key).toEqual(ALTERNATE[key]);
      expect(await getSetting(db.pool, key), key).toEqual(ALTERNATE[key]);
      expect((await db.pool.query("select updated_by from settings where key = $1", [key])).rows[0].updated_by).toBe("session");
    }
  });

  it("a token may still write a NON-safety key (the rule is about safety keys, not a blanket ban)", async () => {
    const r = await setSetting(db.pool, "jobs.concurrent_jobs", 3, { actor: "token" });
    expect(r.new).toBe(3);
  });
});
