import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dueLimitRuns, finishEngineRun, markResumed, startEngineRun, usageWindow } from "@/server/db/engine-runs";
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
