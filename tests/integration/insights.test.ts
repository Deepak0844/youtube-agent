import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { learningNotes } from "@/server/core/insights";
import { SCHEDULER_DEFAULTS } from "@/server/core/scheduler";
import {
  ModelUnavailable, decideProposal, evaluateTitleTest, latestReview, listProposals, loadInsightShorts, noInsightsModel, planTitleTest, recordTitleWindow,
  runOptimizer, runWeeklyReview, type InsightsModel,
} from "@/server/db/insights";
import { runDueJobs } from "@/server/db/scheduler";
import { saveSchedulerSettings } from "@/server/db/system-settings";
import { addContent, createVideoRow } from "@/server/db/videos";
import { withTestDb, type TestDb } from "../support/db";

// Weekly review, optimizer and title tests with a FAKE model. No real model, no network.
let db: TestDb;
const NOW = new Date("2026-11-09T15:30:00Z"); // Monday 21:00 IST, ISO week 2026-W46
const BY = { kind: "worker" } as const;

interface FakeModel extends InsightsModel { calls: Array<{ kind: string; maxUsd: number; prompt: string }> }
const fakeModel = (text: string, costUsd = 0.05): FakeModel => {
  const m: FakeModel = { calls: [], run: async (a) => { m.calls.push(a); return { text, costUsd }; } };
  return m;
};

async function shorts(n: number, o: { upload?: boolean } = {}): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const v = await createVideoRow(db.pool, { format: "short", kind: "tsx", language: "en", topic: `topic ${i}`, channelId: "UCchan1" });
    ids.push(v.id);
    if (o.upload !== false) {
      await db.ownerPool.query("insert into uploads (id, video_id, status, channel_id, youtube_id, finished_at, attempt) values (gen_random_uuid(), $1, 'uploaded', 'UCchan1', $2, $3, 1)", [v.id, `yt${String(i).padStart(9, "0")}`, NOW]);
      await db.ownerPool.query(
        "insert into video_analytics (video_id, youtube_id, day, views, avg_view_pct, retention) values ($1, $2, '2026-11-08', $3, $4, $5::jsonb)",
        [v.id, `yt${String(i).padStart(9, "0")}`, 100 * (i + 1), 50 + i, JSON.stringify([[0, 1], [0.5, 0.6], [1, 0.2]])],
      );
      await addContent(db.pool, v.id, "beats", { body: { beats: [{ id: "hook", text: "aaaa" }, { id: "reveal", text: "bbbb" }] }, sha256: "0".repeat(64) });
    }
  }
  return ids;
}

beforeAll(async () => { db = await withTestDb(); });
afterAll(async () => { await db?.stop(); });
beforeEach(async () => {
  await db.reset();
  await db.ownerPool.query("truncate reviews, proposals, title_experiments, schedule_runs, notifications cascade");
  await db.ownerPool.query("delete from settings where key = 'scheduler'");
});

describe("weekly review", () => {
  it("under_10_shorts_has_numbers_no_model_call_and_a_low_confidence_label", async () => {
    await shorts(3);
    const m = fakeModel('{"observations":["x"]}');
    const r = await runWeeklyReview(db.pool, m, BY, { now: NOW });
    expect(m.calls).toHaveLength(0);
    expect(r).toMatchObject({ week: "2026-W46", costMicroUsd: 0 });
    const v = (await latestReview(db.pool))!;
    expect(v.report).toMatchObject({ shortsWithData: 3, lowConfidence: true, shipped: 3, views: 600 });
    expect(v.report.niches[0]).toMatchObject({ niche: "tsx · en", shorts: 3, lowConfidence: true });
    expect(v.report.beats[0]!.beat).toBe("hook"); // 0.4 lost in each beat; ties sort by name
    expect(v.notes[0]).toContain("Only 3 shorts");
  });

  it("at_10_shorts_the_model_adds_observations_only_with_the_0_20_dollar_cap_and_the_cost_is_stored", async () => {
    await shorts(10);
    const m = fakeModel('{"observations":["Hook keeps viewers.","Second point."]}', 0.04);
    const r = await runWeeklyReview(db.pool, m, BY, { now: NOW });
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]).toMatchObject({ kind: "review", maxUsd: 0.2 });
    expect(m.calls[0]!.prompt).toContain("DATA");
    expect(r.costMicroUsd).toBe(40_000);
    const v = (await latestReview(db.pool))!;
    expect(v.notes).toEqual(["Hook keeps viewers.", "Second point."]);
    expect(v.report.lowConfidence).toBe(false);
    expect(v.report.views).toBe(5500); // numbers come from data, not from the model
    expect(v.costMicroUsd).toBe(40_000);
  });

  it("a_model_that_costs_more_than_the_cap_has_its_observations_dropped_but_the_cost_is_kept", async () => {
    await shorts(10);
    await runWeeklyReview(db.pool, fakeModel('{"observations":["x"]}', 0.25), BY, { now: NOW });
    const v = (await latestReview(db.pool))!;
    expect(v.notes[0]).toContain("cost more than the $0.20 cap");
    expect(v.costMicroUsd).toBe(250_000);
  });

  it("an_unpriced_or_missing_model_refuses_and_the_review_still_has_its_numbers", async () => {
    await shorts(10);
    const unpriced: InsightsModel = { run: async () => { throw new ModelUnavailable("the model has no price, so it cannot be used"); } };
    await runWeeklyReview(db.pool, unpriced, BY, { now: NOW });
    const v = (await latestReview(db.pool))!;
    expect(v.notes[0]).toContain("has no price");
    expect(v.report.shortsWithData).toBe(10);
    await runWeeklyReview(db.pool, noInsightsModel, BY, { now: NOW });
    expect((await latestReview(db.pool))!.notes[0]).toContain("no text model");
  });

  it("garbage_from_the_model_is_not_stored_as_observations", async () => {
    await shorts(10);
    await runWeeklyReview(db.pool, fakeModel("<script>alert(1)</script> not json"), BY, { now: NOW });
    expect((await latestReview(db.pool))!.notes).toEqual(["(the model gave no usable observations)"]);
  });

  it("a_second_run_in_the_same_week_replaces_the_review_and_each_run_sends_weekly_review_ready_and_an_audit_row", async () => {
    await shorts(2);
    await runWeeklyReview(db.pool, noInsightsModel, BY, { now: NOW });
    await runWeeklyReview(db.pool, noInsightsModel, { kind: "session", sessionId: "11111111-1111-4111-8111-111111111111" }, { now: new Date(NOW.getTime() + 60_000) });
    expect((await db.ownerPool.query("select count(*)::int as n from reviews")).rows[0].n).toBe(1);
    expect((await db.ownerPool.query("select count(*)::int as n from notifications where event = 'weekly_review_ready'")).rows[0].n).toBe(2);
    expect((await db.ownerPool.query("select count(*)::int as n from audit_log where event = 'review.generated'")).rows[0].n).toBe(2);
  });

  it("counts_failures_and_spend_of_the_last_7_days_and_gives_cost_per_short", async () => {
    const [id] = await shorts(2);
    await db.ownerPool.query("insert into stage_runs (id, video_id, name, status, input_hash, updated_at) values (gen_random_uuid(), $1, 'voice', 'failed', 'h', $2)", [id, NOW]);
    await db.ownerPool.query("insert into stage_runs (id, video_id, name, status, input_hash, updated_at) values (gen_random_uuid(), $1, 'voice', 'failed', 'h', '2026-10-01')", [id]);
    const sr = (await db.ownerPool.query("insert into stage_runs (id, video_id, name, status, input_hash) values (gen_random_uuid(), $1, 'script', 'succeeded', 'h') returning id", [id])).rows[0].id;
    await db.ownerPool.query("insert into spend_intents (id, stage_run_id, step_index, tool_call_index, call_key, status, actual_micro_usd, created_at) values (gen_random_uuid(), $1, 0, 0, 'k1', 'done', 3000000, $2)", [sr, NOW]);
    await runWeeklyReview(db.pool, noInsightsModel, BY, { now: NOW });
    expect((await latestReview(db.pool))!.report).toMatchObject({ failures: 1, spendMicroUsd: 3_000_000, costPerShortMicroUsd: 1_500_000 });
  });
});

describe("learning notes input", () => {
  it("loadInsightShorts_feeds_the_pure_learning_function_which_is_silent_below_10", async () => {
    await shorts(9);
    expect(learningNotes(await loadInsightShorts(db.pool))).toEqual([]);
    await shorts(1);
    expect(learningNotes(await loadInsightShorts(db.pool))).toHaveLength(1);
  });
});

describe("optimizer", () => {
  const proposals = (vid: string) => JSON.stringify({ proposals: [
    { kind: "title", video: vid, title: "Try a question title", detail: "weakest short", payload: { title: "Why is the sky blue?" } },
    { kind: "spend", title: "Buy ads", detail: "", payload: {} },
    { kind: "policy", title: "Post at 6pm", detail: "no data yet", payload: {} },
  ] });

  it("is_silent_and_does_not_call_the_model_below_10_shorts", async () => {
    await shorts(3);
    const m = fakeModel("{}");
    expect(await runOptimizer(db.pool, m, BY, { now: NOW })).toMatchObject({ made: 0 });
    expect(m.calls).toHaveLength(0);
  });

  it("writes_valid_proposals_with_the_0_30_dollar_cap_and_drops_invalid_kinds", async () => {
    const ids = await shorts(10);
    const m = fakeModel(proposals(ids[0]!), 0.1);
    const r = await runOptimizer(db.pool, m, BY, { now: NOW });
    expect(m.calls[0]).toMatchObject({ kind: "optimizer", maxUsd: 0.3 });
    expect(r).toMatchObject({ made: 2, costMicroUsd: 100_000 });
    const list = await listProposals(db.pool);
    expect(list.map((p) => [p.kind, p.status])).toEqual([["policy", "open"], ["title", "open"]].sort());
    expect(list.find((p) => p.kind === "title")).toMatchObject({ videoId: ids[0], topic: "topic 0" });
  });

  it("an_unavailable_model_is_a_quiet_skip_not_a_failure", async () => {
    await shorts(10);
    expect(await runOptimizer(db.pool, noInsightsModel, BY, { now: NOW })).toMatchObject({ made: 0, message: expect.stringContaining("skipped") });
  });

  it("accepting_only_records_the_decision_and_changes_nothing_else", async () => {
    const ids = await shorts(10);
    await runOptimizer(db.pool, fakeModel(proposals(ids[0]!)), BY, { now: NOW });
    const title = (await listProposals(db.pool)).find((p) => p.kind === "title")!;
    const videosBefore = (await db.ownerPool.query("select id, topic, notes, status from videos order by id")).rows;
    const contentBefore = (await db.ownerPool.query("select count(*)::int as n from video_content")).rows[0].n;
    expect(await decideProposal(db.pool, title.id, "accept", "11111111-1111-4111-8111-111111111111")).toEqual({ ok: true });
    expect((await db.ownerPool.query("select id, topic, notes, status from videos order by id")).rows).toEqual(videosBefore);
    expect((await db.ownerPool.query("select count(*)::int as n from video_content")).rows[0].n).toBe(contentBefore);
    expect((await listProposals(db.pool)).find((p) => p.id === title.id)!.status).toBe("accepted");
    expect((await db.ownerPool.query("select detail from audit_log where event = 'proposal.decided'")).rows[0].detail).toMatchObject({ decision: "accept", kind: "title" });
  });

  it("a_decision_is_final_and_unknown_ids_are_refused", async () => {
    const ids = await shorts(10);
    await runOptimizer(db.pool, fakeModel(proposals(ids[0]!)), BY, { now: NOW });
    const p = (await listProposals(db.pool))[0]!;
    expect((await decideProposal(db.pool, p.id, "dismiss", "s")).ok).toBe(true);
    expect((await decideProposal(db.pool, p.id, "accept", "s")).ok).toBe(false);
    expect((await decideProposal(db.pool, "999999", "accept", "s")).ok).toBe(false);
    expect((await decideProposal(db.pool, "1; drop table proposals", "accept", "s")).ok).toBe(false);
  });
});

describe("title experiments", () => {
  const snap = (id: string, day: string, views: number) =>
    db.ownerPool.query("insert into video_analytics (video_id, youtube_id, day, views) values ($1, 'ytxxxxxxxxx', $2, $3) on conflict (video_id, day) do update set views = excluded.views", [id, day, views]);

  it("plans_records_two_windows_from_saved_snapshots_and_concludes", async () => {
    const [id] = await shorts(1);
    await db.ownerPool.query("delete from video_analytics");
    for (const [d, v] of [["2026-10-01", 100], ["2026-10-08", 400], ["2026-10-15", 850]] as const) await snap(id!, d, v);
    const plan = await planTitleTest(db.pool, { videoId: id!, titleA: "Why the sky is blue", titleB: "Sky blue explained", windowDays: 7 });
    expect(plan.ok).toBe(true);
    const eid = (plan as { id: string }).id;
    expect((await evaluateTitleTest(db.pool, eid)).ok).toBe(false); // needs both windows
    expect((await recordTitleWindow(db.pool, eid, "A", "2026-10-01", "2026-10-08")).ok).toBe(true);
    expect((await recordTitleWindow(db.pool, eid, "B", "2026-10-08", "2026-10-15")).ok).toBe(true);
    const r = await evaluateTitleTest(db.pool, eid);
    expect(r).toMatchObject({ ok: true, result: { verdict: "b_better", confounded: true } });
    expect((await db.ownerPool.query("select status from title_experiments")).rows[0].status).toBe("concluded");
  });

  it("refuses_a_video_that_is_not_uploaded_equal_titles_and_a_window_with_no_snapshot", async () => {
    const [draft] = await shorts(1, { upload: false });
    expect((await planTitleTest(db.pool, { videoId: draft!, titleA: "Title one here", titleB: "Title two here", windowDays: 7 })).ok).toBe(false);
    const [id] = await shorts(1);
    expect((await planTitleTest(db.pool, { videoId: id!, titleA: "Same title", titleB: "Same title", windowDays: 7 })).ok).toBe(false);
    expect((await planTitleTest(db.pool, { videoId: id!, titleA: "Title one here", titleB: "Title two here", windowDays: 40 })).ok).toBe(false);
    const p = (await planTitleTest(db.pool, { videoId: id!, titleA: "Title one here", titleB: "Title two here", windowDays: 7 })) as { id: string };
    expect((await recordTitleWindow(db.pool, p.id, "A", "2020-01-01", "2020-01-08")).ok).toBe(false);
  });
});

describe("scheduler jobs", () => {
  it("weekly_review_and_optimizer_run_once_per_period_through_runDueJobs", async () => {
    await saveSchedulerSettings(db.pool, { ...SCHEDULER_DEFAULTS, analytics: false, weekly_review: true, weekly_day: 0, weekly_hour: 20, optimizer: true, optimizer_hour: 21 }, false);
    const ran: string[] = [];
    const runners = { weekly_review: async () => { ran.push("w"); return "ok"; }, optimizer: async () => { ran.push("o"); } };
    expect(await runDueJobs(db.pool, runners, undefined, NOW)).toEqual(["weekly_review", "optimizer"]);
    expect(await runDueJobs(db.pool, runners, undefined, NOW)).toEqual([]);
    expect(ran).toEqual(["w", "o"]);
    const keys = (await db.ownerPool.query("select job, run_key from schedule_runs order by job")).rows;
    expect(keys).toEqual([{ job: "optimizer", run_key: "2026-11-09" }, { job: "weekly_review", run_key: "2026-W46" }]);
  });
});
