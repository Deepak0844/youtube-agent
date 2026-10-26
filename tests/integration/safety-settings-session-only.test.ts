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
