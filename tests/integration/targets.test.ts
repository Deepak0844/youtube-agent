import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SCHEDULER_DEFAULTS } from "@/server/core/scheduler";
import { loadScheduler, loadTargetSettings, saveSchedulerSettings, saveTargetSettings } from "@/server/db/system-settings";
import { applyStartingTargets, checkTargetPause, loadTargets, removeTarget, saveTarget } from "@/server/db/targets";
import { createVideoRow } from "@/server/db/videos";
import { ensureChannel } from "../support/channel-fixture";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
beforeAll(async () => { db = await withTestDb(); });
afterAll(async () => { await db.stop(); });
beforeEach(async () => {
  await db.reset();
  await db.ownerPool.query("truncate targets");
  await db.ownerPool.query("delete from settings where key in ('scheduler', 'targets.pause_n', 'targets.rpm_usd', 'targets.pause_fired')");
  await db.ownerPool.query("truncate notifications cascade");
});

describe("targets", () => {
  it("saving_the_same_channel_and_metric_replaces_it", async () => {
    expect((await saveTarget(db.pool, { channelId: null, metric: "avg_view_pct", value: "70" })).ok).toBe(true);
    expect((await saveTarget(db.pool, { channelId: null, metric: "avg_view_pct", value: "75.5" })).ok).toBe(true);
    const v = await loadTargets(db.pool);
    expect(v.targets).toMatchObject([{ metric: "avg_view_pct", op: ">=", value: 75.5, status: "no_data", actual: null }]);
  });
  it.each([["views", "-1"], ["views", "abc"], ["views", "1e9"], ["nope", "5"]])("rejects_%s_%s", async (metric, value) => {
    expect((await saveTarget(db.pool, { channelId: null, metric, value })).ok).toBe(false);
  });
  it("starting_targets_add_only_the_missing_ones_and_never_touch_an_existing_value", async () => {
    await saveTarget(db.pool, { channelId: null, metric: "cost_per_short", value: "1" });
    expect((await applyStartingTargets(db.pool)).made).toEqual(["avg_view_pct"]);
    expect((await applyStartingTargets(db.pool)).made).toEqual([]);
    const byMetric = Object.fromEntries((await loadTargets(db.pool)).targets.map((t) => [t.metric, t.value]));
    expect(byMetric).toEqual({ avg_view_pct: 70, cost_per_short: 1 });
  });
  it("subscribers_per_week_uses_each_channels_newest_good_week", async () => {
    await ensureChannel(db.pool, "UCa");
    await ensureChannel(db.pool, "UCb");
    const row = (ch: string, day: string, g: number | null, l: number | null, err: string | null = null) =>
      db.pool.query("insert into channel_analytics (channel_id, day, start_day, end_day, subscribers_gained, subscribers_lost, error) values ($1, $2::date, $2::date - 8, $2::date - 2, $3, $4, $5)", [ch, day, g, l, err]);
    await row("UCa", "2026-11-01", 5, 0);
    await row("UCa", "2026-11-08", 30, 5);
    await row("UCa", "2026-11-09", null, null, "answered 500"); // a failed newer pull does not hide the good one
    await row("UCb", "2026-11-08", 10, 0);
    await saveTarget(db.pool, { channelId: null, metric: "subscribers_per_week", value: "40" });
    await saveTarget(db.pool, { channelId: "UCb", metric: "subscribers_per_week", value: "20" });
    const t = Object.fromEntries((await loadTargets(db.pool)).targets.map((x) => [x.channelId ?? "all", x]));
    expect(t.all).toMatchObject({ actual: 35, n: 2, status: "behind" });
    expect(t.UCb).toMatchObject({ actual: 10, n: 1, status: "behind" });
  });
  it("remove_deletes_the_target", async () => {
    await saveTarget(db.pool, { channelId: null, metric: "views", value: "1000" });
    const [t] = (await loadTargets(db.pool)).targets;
    expect((await removeTarget(db.pool, String(t!.id))).ok).toBe(true);
    expect((await loadTargets(db.pool)).targets).toEqual([]);
  });
});

describe("pause settings", () => {
  it("defaults_are_off_and_zero", async () => {
    expect(await loadTargetSettings(db.pool)).toEqual({ pauseN: 0, rpmUsd: 0, pauseFired: null });
  });
  it("rejects_bad_numbers_and_saves_good_ones", async () => {
    expect((await saveTargetSettings(db.pool, { pauseN: "51", rpmUsd: "0" })).ok).toBe(false);
    expect((await saveTargetSettings(db.pool, { pauseN: "3", rpmUsd: "-1" })).ok).toBe(false);
    expect((await saveTargetSettings(db.pool, { pauseN: "3", rpmUsd: "0.5" })).ok).toBe(true);
    expect(await loadTargetSettings(db.pool)).toMatchObject({ pauseN: 3, rpmUsd: 0.5 });
  });
});

// n uploaded videos, oldest first, each with `views` and `spendUsd` of spend (so spendUsd / (views / 1000) dollars per 1,000 views).
async function seedShorts(n: number, views: number, spendUsd: number) {
  for (let i = 0; i < n; i++) {
    const v = await createVideoRow(db.pool, { format: "short", kind: "collage", language: "en", topic: `topic ${i}`, channelId: "UCchan1" });
    await db.ownerPool.query("update videos set created_at = now() - ($2 || ' hours')::interval where id = $1", [v.id, String(n - i)]);
    const yt = `yt${String(i).padStart(9, "0")}`;
    await db.ownerPool.query(
      "insert into uploads (id, video_id, status, channel_id, youtube_id, started_at, finished_at, attempt) values (gen_random_uuid(), $1, 'uploaded', 'UCchan1', $2, now(), now(), 1)",
      [v.id, yt],
    );
    await db.ownerPool.query("insert into video_analytics (video_id, youtube_id, day, views, avg_view_pct) values ($1, $2, current_date, $3, 60)", [v.id, yt, views]);
    const sr = await db.ownerPool.query<{ id: string }>("insert into stage_runs (id, video_id, name, input_hash, status) values (gen_random_uuid(), $1, 'draft', 'h', 'succeeded') returning id", [v.id]);
    await db.ownerPool.query(
      "insert into spend_intents (id, stage_run_id, step_index, tool_call_index, call_key, status, actual_micro_usd) values (gen_random_uuid(), $1, 0, 0, $2, 'done', $3)",
      [sr.rows[0]!.id, `k${v.id}`, spendUsd * 1e6],
    );
  }
}

describe("checkTargetPause", () => {
  const arm = async (n: number) => {
    await saveSchedulerSettings(db.pool, { ...SCHEDULER_DEFAULTS, enabled: true }, true);
    await saveTarget(db.pool, { channelId: null, metric: "cost_per_1k_views", value: "2" });
    await saveTargetSettings(db.pool, { pauseN: String(n), rpmUsd: "0" });
  };
  it("pauses_drafting_once_notifies_and_only_turns_drafting_off", async () => {
    await seedShorts(3, 1000, 5);
    await arm(3);
    expect(await checkTargetPause(db.pool)).toBe(true);
    expect((await loadScheduler(db.pool)).enabled).toBe(false);
    expect((await loadTargetSettings(db.pool)).pauseFired).not.toBeNull();
    expect((await db.ownerPool.query("select 1 from notifications where event = 'drafting_paused'")).rowCount).toBe(1);
    // the owner turns drafting back on: the rule has fired already, so it does not pause again until the rule is saved
    await saveSchedulerSettings(db.pool, { ...SCHEDULER_DEFAULTS, enabled: true }, true);
    expect(await checkTargetPause(db.pool)).toBe(false);
    expect((await loadScheduler(db.pool)).enabled).toBe(true);
    await saveTargetSettings(db.pool, { pauseN: "3", rpmUsd: "0" });
    expect(await checkTargetPause(db.pool)).toBe(true);
  });
  it("does_nothing_when_cost_is_under_the_target", async () => {
    await seedShorts(3, 1000, 1);
    await arm(3);
    expect(await checkTargetPause(db.pool)).toBe(false);
    expect((await loadScheduler(db.pool)).enabled).toBe(true);
  });
  it("does_nothing_with_fewer_than_n_shorts_or_when_the_rule_is_off", async () => {
    await seedShorts(2, 1000, 5);
    await arm(3);
    expect(await checkTargetPause(db.pool)).toBe(false);
    await saveTargetSettings(db.pool, { pauseN: "0", rpmUsd: "0" });
    expect(await checkTargetPause(db.pool)).toBe(false);
  });
  it("does_nothing_when_drafting_is_already_off", async () => {
    await seedShorts(3, 1000, 5);
    await saveTarget(db.pool, { channelId: null, metric: "cost_per_1k_views", value: "2" });
    await saveTargetSettings(db.pool, { pauseN: "3", rpmUsd: "0" });
    expect(await checkTargetPause(db.pool)).toBe(false);
  });
});
