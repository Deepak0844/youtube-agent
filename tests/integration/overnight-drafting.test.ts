import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SCHEDULER_DEFAULTS } from "@/server/core/scheduler";
import { runOvernightDrafting } from "@/server/db/drafting";
import { recentRuns, runDueJobs } from "@/server/db/scheduler";
import { saveSchedulerSettings } from "@/server/db/system-settings";
import { createVideoRow } from "@/server/db/videos";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
beforeAll(async () => { db = await withTestDb(); });
afterAll(async () => { await db?.stop(); });
beforeEach(async () => { await db.reset(); await setCaps(null, null); });

const queue = { enqueue: async (id: string, fence: number, seq: number) => `stage.${id}.${fence}.${seq}` };
const NIGHT = new Date("2026-11-06T21:00:00Z"); // 02:30 IST on 2026-11-07
const TOPICS = ["Quantum tunnelling explained", "Why the sky is blue", "How vaccines train immunity", "The physics of a boomerang", "Black holes and time", "Why cats purr"];

async function setSettings(o: Partial<typeof SCHEDULER_DEFAULTS>) {
  const r = await saveSchedulerSettings(db.pool, { ...SCHEDULER_DEFAULTS, enabled: true, analytics: false, competitors: false, weekly_review: false, max_drafts: 5, max_pending: 10, ...o }, true);
  expect(r.ok).toBe(true);
}
async function setCaps(day: number | null, month: number | null) {
  for (const [scope, cap] of [["day", day], ["month", month]] as const) {
    await db.ownerPool.query("insert into budgets (scope, cap_micro_usd) values ($1, $2) on conflict (scope) do update set cap_micro_usd = excluded.cap_micro_usd", [scope, cap]);
  }
}
async function seed(topics: string[]) {
  for (const [i, t] of topics.entries()) await db.ownerPool.query("insert into ideas (topic, score) values ($1, $2)", [t, 9 - i]);
}
const count = async (sql: string) => Number((await db.ownerPool.query(sql)).rows[0].n);
const videos = () => count("select count(*) n from videos");

describe("runOvernightDrafting", () => {
  it("never_exceeds_max_drafts_and_takes_the_best_scores_first", async () => {
    await seed(TOPICS);
    await setSettings({ max_drafts: 2 });
    await runOvernightDrafting(db.pool, queue);
    expect(await videos()).toBe(2);
    const { rows } = await db.ownerPool.query("select topic from videos");
    expect(rows.map((r) => r.topic).sort()).toEqual([TOPICS[0], TOPICS[1]].sort());
    expect(await count("select count(*) n from audit_log where event = 'scheduler.draft_started'")).toBe(2);
  });
  it("respects_max_pending", async () => {
    await seed(TOPICS);
    await setSettings({ max_pending: 3, max_drafts: 5 });
    for (const t of ["Old one alpha", "Old one bravo", "Old one charlie"]) {
      const v = await createVideoRow(db.pool, { format: "short", kind: "tsx", language: "en", topic: t });
      await db.ownerPool.query("update videos set status = 'waiting' where id = $1", [v.id]);
    }
    const before = await videos();
    await runOvernightDrafting(db.pool, queue);
    expect(await videos()).toBe(before);
  });
  it("counts_its_own_starts_toward_max_pending", async () => {
    await seed(TOPICS);
    await setSettings({ max_pending: 2, max_drafts: 5 });
    await runOvernightDrafting(db.pool, queue);
    expect(await videos()).toBe(2);
  });
  it("respects_a_low_daily_budget_and_no_limit_counts_as_enough", async () => {
    await seed(TOPICS);
    await setSettings({ max_drafts: 1 });
    await setCaps(900_000, null); // $0.90 left
    await runOvernightDrafting(db.pool, queue);
    expect(await videos()).toBe(0);
    await setCaps(null, null);
    await runOvernightDrafting(db.pool, queue);
    expect(await videos()).toBe(1);
  });
  it("respects_a_low_monthly_budget", async () => {
    await seed(TOPICS);
    await setSettings({});
    await setCaps(null, 500_000);
    await runOvernightDrafting(db.pool, queue);
    expect(await videos()).toBe(0);
  });
  it("stops_after_two_failed_starts", async () => {
    // Blank topics pass the table check but fail the new video rules, so each start fails.
    await db.ownerPool.query("insert into ideas (topic, score) values ('        ', 9), ('         ', 8), ('          ', 7), ($1, 1)", [TOPICS[0]]);
    await setSettings({});
    const msg = await runOvernightDrafting(db.pool, queue);
    expect(msg).toContain("2 failed");
    expect(await videos()).toBe(0);
    expect(await count("select count(*) n from ideas where status = 'proposed'")).toBe(4);
  });
  it("does_nothing_when_disabled", async () => {
    await seed(TOPICS);
    await setSettings({ enabled: false });
    await runOvernightDrafting(db.pool, queue);
    expect(await videos()).toBe(0);
  });
  it("flipping_enabled_off_mid_run_stops_further_drafts", async () => {
    await seed(TOPICS);
    await setSettings({ max_drafts: 5 });
    let n = 0;
    const flipping = { enqueue: async (id: string, fence: number, seq: number) => {
      if (++n === 1) await setSettings({ enabled: false, max_drafts: 5 });
      return `stage.${id}.${fence}.${seq}`;
    } };
    await runOvernightDrafting(db.pool, flipping);
    expect(await videos()).toBe(1);
  });
  it("skips_an_idea_too_like_an_existing_video", async () => {
    await createVideoRow(db.pool, { format: "short", kind: "tsx", language: "en", topic: TOPICS[0]! });
    await seed([TOPICS[0]!]);
    await setSettings({});
    await runOvernightDrafting(db.pool, queue);
    expect(await videos()).toBe(1);
  });
  it("never_writes_an_approval_or_upload_row", async () => {
    await seed(TOPICS);
    await setSettings({ max_drafts: 3 });
    await runOvernightDrafting(db.pool, queue);
    expect(await videos()).toBe(3);
    expect(await count("select count(*) n from approvals")).toBe(0);
    expect(await count("select count(*) n from uploads")).toBe(0);
  });
});

describe("drafting through the scheduler", () => {
  it("runs_once_per_night_nothing_outside_the_window_and_logs_the_outcome", async () => {
    await seed(TOPICS);
    await setSettings({ max_drafts: 1, hour: 2 });
    let n = 0;
    const runners = { drafting: async () => { n++; return runOvernightDrafting(db.pool, queue); } };
    expect(await runDueJobs(db.pool, runners, undefined, new Date("2026-11-06T19:30:00Z"))).toEqual([]); // 01:00 IST
    expect(await runDueJobs(db.pool, runners, undefined, NIGHT)).toEqual(["drafting"]);
    expect(await runDueJobs(db.pool, runners, undefined, new Date("2026-11-06T22:00:00Z"))).toEqual([]); // same night
    expect(n).toBe(1);
    expect(await videos()).toBe(1);
    const [r] = await recentRuns(db.pool);
    expect(r).toMatchObject({ job: "drafting", runKey: "2026-11-07", status: "ok" });
    expect(r!.message).toContain("1 started");
  });
  it("a_disabled_scheduler_never_claims_the_night", async () => {
    await seed(TOPICS);
    await setSettings({ enabled: false });
    expect(await runDueJobs(db.pool, { drafting: async () => "x" }, undefined, NIGHT)).toEqual([]);
  });
});
