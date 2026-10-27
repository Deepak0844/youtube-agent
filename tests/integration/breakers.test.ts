import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTestDb, type TestDb } from "../support/db";
import { breakerAllowsNow, recordBreakerEvent } from "@/server/db/breakers";
import { getEngineConfig } from "@/server/db/engine-config";
import { setSetting } from "@/server/db/settings";

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

// reset() truncates settings too, so re-seed the engine numbers the way the migration does.
beforeEach(async () => {
  const { readFile } = await import("node:fs/promises");
  await db.ownerPool.query(await readFile("src/server/db/migrations/0014_breakers.sql", "utf8"));
});

const fail3 = async (stage = "draft") => {
  for (let i = 0; i < 3; i++) await recordBreakerEvent(db.pool, stage, "failure");
};

describe("breakers (database)", () => {
  it("migration seeds the engine numbers and getEngineConfig reads them", async () => {
    const c = await getEngineConfig(db.pool);
    expect(c.retryBackoffSeconds).toEqual([30, 120, 480]);
    expect(c.breaker).toEqual({ threshold: 3, cooldownS: 900, stages: ["draft", "build", "voice"] });
  });

  it("a stored invalid value throws instead of falling back to the default", async () => {
    await db.ownerPool.query("update settings set value = '0' where key = 'engine.retry_attempts'");
    await expect(getEngineConfig(db.pool)).rejects.toThrow(/engine\.retry_attempts/);
  });

  it("opens_after_consecutive_failures_and_holds_the_queue", async () => {
    await recordBreakerEvent(db.pool, "draft", "failure");
    await recordBreakerEvent(db.pool, "draft", "failure");
    expect(await breakerAllowsNow(db.pool, "draft")).toBe(true);
    await recordBreakerEvent(db.pool, "draft", "failure");
    expect(await breakerAllowsNow(db.pool, "draft")).toBe(false);
  });

  it("reset_releases_the_queue", async () => {
    await fail3();
    await recordBreakerEvent(db.pool, "draft", "reset");
    expect(await breakerAllowsNow(db.pool, "draft")).toBe(true);
  });

  it("cooldown_elapses_to_half_open_and_success_closes (db clock)", async () => {
    await fail3();
    await db.ownerPool.query("update breakers set opened_at = clock_timestamp() - interval '901 seconds' where stage = 'draft'");
    expect(await breakerAllowsNow(db.pool, "draft")).toBe(true);
    const s = await recordBreakerEvent(db.pool, "draft", "success");
    expect(s.status).toBe("closed");
    const row = (await db.pool.query("select status, failures, opened_at from breakers where stage='draft'")).rows[0];
    expect(row).toMatchObject({ status: "closed", failures: 0, opened_at: null });
  });

  it("a half-open failure reopens it with a fresh cooldown", async () => {
    await fail3();
    await db.ownerPool.query("update breakers set opened_at = clock_timestamp() - interval '901 seconds' where stage = 'draft'");
    await recordBreakerEvent(db.pool, "draft", "failure");
    expect(await breakerAllowsNow(db.pool, "draft")).toBe(false);
  });

  it("a_success_in_between_keeps_it_closed_and_other_stages_are_unaffected", async () => {
    await recordBreakerEvent(db.pool, "build", "failure");
    await recordBreakerEvent(db.pool, "build", "failure");
    await recordBreakerEvent(db.pool, "build", "success");
    await recordBreakerEvent(db.pool, "build", "failure");
    expect(await breakerAllowsNow(db.pool, "build")).toBe(true);
    await fail3("draft");
    expect(await breakerAllowsNow(db.pool, "draft")).toBe(false);
    expect(await breakerAllowsNow(db.pool, "voice")).toBe(true);
    expect(await breakerAllowsNow(db.pool, "build")).toBe(true);
  });

  it("unknown_stage_reset_rejected, and unguarded stages are never held", async () => {
    await expect(recordBreakerEvent(db.pool, "nonsense", "reset")).rejects.toThrow(/unknown breaker stage/);
    for (let i = 0; i < 10; i++) await recordBreakerEvent(db.pool, "qa", "failure");
    expect(await breakerAllowsNow(db.pool, "qa")).toBe(true);
    expect((await db.pool.query("select count(*)::int n from breakers where stage = 'qa'")).rows[0].n).toBe(0);
  });

  it("concurrent failures are counted exactly (row lock)", async () => {
    await Promise.all([1, 2, 3].map(() => recordBreakerEvent(db.pool, "voice", "failure")));
    expect((await db.pool.query("select failures from breakers where stage='voice'")).rows[0].failures).toBe(3);
    expect(await breakerAllowsNow(db.pool, "voice")).toBe(false);
  });

  it("threshold 0 turns the breaker off", async () => {
    await setSetting(db.pool, "breaker.threshold", 0, { actor: "session" });
    await fail3();
    expect(await breakerAllowsNow(db.pool, "draft")).toBe(true);
  });
});
