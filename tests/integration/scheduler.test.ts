import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SCHEDULER_DEFAULTS } from "@/server/core/scheduler";
import { recentRuns, runDueJobs } from "@/server/db/scheduler";
import { loadScheduler, saveSchedulerSettings } from "@/server/db/system-settings";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
const DUE = new Date("2026-11-07T06:00:00Z"); // 11:30 IST
const EARLY = new Date("2026-11-07T01:00:00Z"); // 06:30 IST

beforeAll(async () => { db = await withTestDb(); });
afterAll(async () => { await db.stop(); });
beforeEach(async () => {
  await db.ownerPool.query("truncate schedule_runs");
  await db.ownerPool.query("delete from settings where key = 'scheduler'");
  await db.ownerPool.query("truncate notifications cascade");
});

describe("runDueJobs", () => {
  it("runs_analytics_once_per_day_even_when_asked_twice", async () => {
    let n = 0;
    const runners = { analytics: async () => { n++; return "pulled 2"; } };
    expect(await runDueJobs(db.pool, runners, undefined, DUE)).toEqual(["analytics"]);
    expect(await runDueJobs(db.pool, runners, undefined, DUE)).toEqual([]);
    expect(n).toBe(1);
    expect(await recentRuns(db.pool)).toMatchObject([{ job: "analytics", runKey: "2026-11-07", status: "ok", message: "pulled 2" }]);
  });
  it("does_nothing_before_09_00_ist", async () => {
    expect(await runDueJobs(db.pool, { analytics: async () => undefined }, undefined, EARLY)).toEqual([]);
  });
  it("a_failed_run_is_logged_not_retried_that_day_and_sends_run_failed", async () => {
    let n = 0;
    const runners = { analytics: async () => { n++; throw new Error("secret-ish provider text"); } };
    await runDueJobs(db.pool, runners, undefined, DUE);
    await runDueJobs(db.pool, runners, undefined, DUE);
    expect(n).toBe(1);
    const [r] = await recentRuns(db.pool);
    expect(r).toMatchObject({ status: "failed" });
    expect(r!.message).not.toContain("secret-ish");
    const { rows } = await db.ownerPool.query("select event from notifications where event = 'run_failed'");
    expect(rows).toHaveLength(1);
  });
  it("analytics_switched_off_runs_nothing", async () => {
    await saveSchedulerSettings(db.pool, { ...SCHEDULER_DEFAULTS, analytics: false }, false);
    expect(await runDueJobs(db.pool, { analytics: async () => undefined }, undefined, DUE)).toEqual([]);
  });
});

describe("saveSchedulerSettings", () => {
  it("defaults_when_nothing_saved_and_drafting_is_off", async () => {
    expect(await loadScheduler(db.pool)).toEqual(SCHEDULER_DEFAULTS);
  });
  it("turning_drafting_on_without_the_spend_confirmation_saves_nothing", async () => {
    const r = await saveSchedulerSettings(db.pool, { ...SCHEDULER_DEFAULTS, enabled: true, hour: 4 }, false);
    expect(r.ok).toBe(false);
    expect(await loadScheduler(db.pool)).toEqual(SCHEDULER_DEFAULTS);
  });
  it("turning_drafting_on_with_the_confirmation_saves_and_audits", async () => {
    const r = await saveSchedulerSettings(db.pool, { ...SCHEDULER_DEFAULTS, enabled: true, hour: 4 }, true);
    expect(r.ok).toBe(true);
    expect(await loadScheduler(db.pool)).toMatchObject({ enabled: true, hour: 4 });
    const { rows } = await db.ownerPool.query("select 1 from audit_log where event = 'setting.changed' and detail->>'setting' = 'scheduler'");
    expect(rows.length).toBeGreaterThan(0);
  });
  it("changing_other_fields_while_already_on_needs_no_new_confirmation", async () => {
    await saveSchedulerSettings(db.pool, { ...SCHEDULER_DEFAULTS, enabled: true }, true);
    expect((await saveSchedulerSettings(db.pool, { ...SCHEDULER_DEFAULTS, enabled: true, max_drafts: 3 }, false)).ok).toBe(true);
  });
  it("rejects_out_of_range_values", async () => {
    expect((await saveSchedulerSettings(db.pool, { ...SCHEDULER_DEFAULTS, hour: 25 }, false)).ok).toBe(false);
  });
});
