import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { finishEngineRun, startEngineRun } from "@/server/db/engine-runs";
import { insertQueuedStage } from "@/server/db/stages";
import { classifyError } from "@/server/core/error-class";
import { createVideoRow } from "@/server/db/videos";
import { EngineLimitError } from "@/server/engine/limit";
import { resumeLimitedSteps } from "@/worker/engine-resume";
import { withTestDb, type TestDb } from "../support/db";

// A step stopped by the Claude usage limit waits (failed, not retried) until its reset time; then the worker queues it again
// exactly once.

let db: TestDb;
beforeAll(async () => {
  db = await withTestDb();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  queued.length = 0;
});
const queued: string[] = [];
const queue = { enqueue: async (id: string, fence: number, seq: number) => (queued.push(id), `stage.${id}.${fence}.${seq}`) };

/** A tsx video whose draft step was stopped by the limit, resuming at `resumeAt`. */
async function paused(resumeAt: Date): Promise<{ videoId: string }> {
  const v = await createVideoRow(db.pool, { format: "short", kind: "tsx", language: "en", topic: "engine" });
  const stageRunId = await insertQueuedStage(db.pool, { videoId: v.id, name: "draft", inputHash: "h0" });
  await db.pool.query("update stage_runs set status = 'failed', result = '{\"error\":\"Claude limit reached.\"}'::jsonb where id = $1", [stageRunId]);
  const r = await startEngineRun(db.pool, { videoId: v.id, stageRunId, kind: "research" });
  if (!r.ok) throw new Error("no run");
  await finishEngineRun(db.pool, r.id, { status: "limit", resumeAt });
  return { videoId: v.id };
}
const draftRuns = async (videoId: string) => (await db.pool.query("select status from stage_runs where video_id = $1 and name = 'draft' order by created_at", [videoId])).rows.map((r) => r.status);

describe("resumeLimitedSteps", () => {
  it("queues the step again after its resume time, exactly once", async () => {
    const { videoId } = await paused(new Date("2026-11-13T14:30:00Z"));
    expect(await resumeLimitedSteps(db.pool, queue, undefined, new Date("2026-11-13T14:29:00Z"))).toBe(0);
    expect(await resumeLimitedSteps(db.pool, queue, undefined, new Date("2026-11-13T14:30:00Z"))).toBe(1);
    expect(await draftRuns(videoId)).toEqual(["failed", "queued"]);
    expect(queued).toHaveLength(1);
    expect(await resumeLimitedSteps(db.pool, queue, undefined, new Date("2026-11-13T15:00:00Z"))).toBe(0);
    expect(queued).toHaveLength(1);
  });

  it("a cancelled video is not resumed (and not asked again)", async () => {
    const { videoId } = await paused(new Date("2026-11-13T14:30:00Z"));
    await db.pool.query("update videos set status = 'cancelled' where id = $1", [videoId]);
    expect(await resumeLimitedSteps(db.pool, queue, undefined, new Date("2026-11-13T15:00:00Z"))).toBe(0);
    expect(await draftRuns(videoId)).toEqual(["failed"]);
    expect((await db.pool.query("select count(*)::int n from engine_runs where resumed_at is not null")).rows[0].n).toBe(1);
  });
});

describe("EngineLimitError", () => {
  it("limit_fails_step_with_note_in_ist", () => {
    const e = new EngineLimitError(new Date("2026-11-13T14:30:00Z"), new Date("2026-11-13T12:00:00Z"));
    expect(e.message).toBe("Claude limit reached. This step resumes about 8:00 PM IST by itself.");
    expect(e.resumeAt).toEqual(new Date("2026-11-13T14:30:00Z"));
    expect(new EngineLimitError(new Date("2026-11-20T04:00:00Z"), new Date("2026-11-13T12:00:00Z")).message).toBe("Claude limit reached. This step resumes about Fri 9:30 AM IST by itself.");
    expect(classifyError(e)).not.toBe("transient"); // the retry sweep only retries "transient": a paused step waits for its time
  });
});
