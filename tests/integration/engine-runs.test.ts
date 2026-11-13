import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dueLimitRuns, engineUsageByStage, engineUsageSummary, finishEngineRun, markResumed, startEngineRun, usageWindow } from "@/server/db/engine-runs";
import { createVideoRow } from "@/server/db/videos";
import { withTestDb, type TestDb } from "../support/db";

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

const video = async () => (await createVideoRow(db.pool, { format: "short", kind: "tsx", language: "en", topic: "engine" })).id;
const STAGE = "0190f3a2-7c1e-7a55-9d3b-2f6c8a1b4e91";
const usage = { inputTokens: 1000, outputTokens: 200, costUsdEquiv: 0.12 };

describe("engine runs", () => {
  it("one_running_run_per_video", async () => {
    const v = await video();
    const a = await startEngineRun(db.pool, { videoId: v, stageRunId: STAGE, kind: "build" });
    expect(a).toMatchObject({ ok: true });
    expect(await startEngineRun(db.pool, { videoId: v, stageRunId: STAGE, kind: "research" })).toEqual({ ok: false, reason: "busy" });
    if (!a.ok) throw new Error("no run");
    await finishEngineRun(db.pool, a.id, { status: "succeeded", usage, turns: 4 });
    expect(await startEngineRun(db.pool, { videoId: v, stageRunId: STAGE, kind: "build" })).toMatchObject({ ok: true }); // finished: free again
    const other = await video();
    expect(await startEngineRun(db.pool, { videoId: other, stageRunId: STAGE, kind: "build" })).toMatchObject({ ok: true }); // other videos are not blocked
  });

  it("limit_run_is_due_after_resume_at_only", async () => {
    const v = await video();
    const r = await startEngineRun(db.pool, { videoId: v, stageRunId: STAGE, kind: "build" });
    if (!r.ok) throw new Error("no run");
    const resumeAt = new Date("2026-11-13T15:00:00Z");
    await finishEngineRun(db.pool, r.id, { status: "limit", resumeAt });
    expect(await dueLimitRuns(db.pool, new Date("2026-11-13T14:59:59Z"))).toEqual([]);
    expect(await dueLimitRuns(db.pool, new Date("2026-11-13T15:00:00Z"))).toEqual([{ runId: r.id, videoId: v, stageRunId: STAGE }]);
    // resumed exactly once, then no longer due
    const tries = await Promise.all([markResumed(db.pool, r.id), markResumed(db.pool, r.id)]);
    expect(tries.filter(Boolean)).toHaveLength(1);
    expect(await dueLimitRuns(db.pool, new Date("2026-11-13T16:00:00Z"))).toEqual([]);
  });

  it("a limit run without a resume time is refused", async () => {
    const v = await video();
    const r = await startEngineRun(db.pool, { videoId: v, stageRunId: STAGE, kind: "build" });
    if (!r.ok) throw new Error("no run");
    await expect(finishEngineRun(db.pool, r.id, { status: "limit" })).rejects.toThrow();
  });

  it("usage_window_sums_finished_runs_since", async () => {
    const v = await video();
    for (const u of [usage, { inputTokens: 500, outputTokens: 100, costUsdEquiv: 0.05 }]) {
      const r = await startEngineRun(db.pool, { videoId: v, stageRunId: STAGE, kind: "build" });
      if (!r.ok) throw new Error("no run");
      await finishEngineRun(db.pool, r.id, { status: "succeeded", usage: u, turns: 2 });
    }
    const w = await usageWindow(db.pool, new Date(Date.now() - 60_000));
    expect(w).toEqual({ runs: 2, inputTokens: 1500, outputTokens: 300, costUsdEquiv: 0.17 });
    expect(await usageWindow(db.pool, new Date(Date.now() + 60_000))).toEqual({ runs: 0, inputTokens: 0, outputTokens: 0, costUsdEquiv: 0 });
  });

  it("rows_go_with_the_video", async () => {
    const v = await video();
    await startEngineRun(db.pool, { videoId: v, stageRunId: STAGE, kind: "build" });
    await db.ownerPool.query("delete from videos where id = $1", [v]);
    expect((await db.pool.query("select count(*)::int n from engine_runs")).rows[0].n).toBe(0);
  });
});

describe("engine usage views", () => {
  const finished = async (v: string, tokens: number, status: "succeeded" | "limit", at: string) => {
    const r = await startEngineRun(db.pool, { videoId: v, stageRunId: STAGE, kind: "build" });
    if (!r.ok) throw new Error("no run");
    await finishEngineRun(db.pool, r.id, { status, usage: { inputTokens: tokens, outputTokens: 0, costUsdEquiv: tokens / 1e5 }, turns: 2, ...(status === "limit" ? { resumeAt: new Date(at) } : {}) });
    await db.pool.query("update engine_runs set ended_at = $2 where id = $1", [r.id, at]);
  };

  it("no estimate before the limit was ever hit; then it learns the window from the 5 hours before it", async () => {
    const [a, b, c] = [await video(), await video(), await video()];
    await finished(a, 1000, "succeeded", "2026-11-13T05:00:00Z");
    await finished(b, 1000, "succeeded", "2026-11-13T06:00:00Z");
    await finished(c, 1000, "succeeded", "2026-11-13T07:00:00Z");
    const now = new Date("2026-11-13T08:00:00Z");
    expect(await engineUsageSummary(db.pool, now)).toMatchObject({ runs: 3, tokens: 3000, videosLeft: null });
    await finished(c, 2000, "limit", "2026-11-13T08:00:00Z"); // 5000 tokens used in the 5 hours up to the limit
    const later = new Date("2026-11-13T14:00:00Z"); // a fresh window: nothing used yet
    expect(await engineUsageSummary(db.pool, later)).toMatchObject({ runs: 0, tokens: 0, videosLeft: 5 }); // 5000 / 1000 per video
  });

  it("usage per step of one video", async () => {
    const v = await video();
    await finished(v, 1200, "succeeded", "2026-11-13T05:00:00Z");
    await db.pool.query("insert into stage_runs (id, video_id, name, status, input_hash) values ($1, $2, 'tsx_author', 'succeeded', 'h') on conflict do nothing", [STAGE, v]);
    expect(await engineUsageByStage(db.pool, v)).toEqual([{ stage: "tsx_author", inputTokens: 1200, outputTokens: 0, costUsdEquiv: 0.012, turns: 2 }]);
  });
});
