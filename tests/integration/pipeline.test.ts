import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { GateId } from "@/server/core/gates";
import { reconcile } from "@/server/db/reconciler";
import { claimStage, commitStage, failStage, getStage } from "@/server/db/stages";
import { addContent, createVideoRow } from "@/server/db/videos";
import { advanceAll, advanceVideo, cancelVideo, rerunStage, type PipelineReaders } from "@/server/db/pipeline";
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

const input = { format: "short", kind: "scene_kit", language: "en", topic: "Why the sky is blue" } as const;
const h = (c: string) => c.repeat(64).slice(0, 64);

interface FakeQueue {
  calls: Array<{ id: string; fence: number; attemptSeq: number; inputHash: string }>;
  failNext: number;
  enqueue(id: string, fence: number, attemptSeq: number, inputHash: string): Promise<string>;
  liveJobIds(): Promise<Set<string>>;
}
function fakeQueue(): FakeQueue {
  const q: FakeQueue = {
    calls: [],
    failNext: 0,
    async enqueue(id, fence, attemptSeq, inputHash) {
      if (q.failNext > 0) {
        q.failNext--;
        throw new Error("redis down");
      }
      q.calls.push({ id, fence, attemptSeq, inputHash });
      return `stage.${id}.${fence}.${attemptSeq}`;
    },
    async liveJobIds() {
      return new Set(q.calls.map((c) => `stage.${c.id}.${c.fence}.${c.attemptSeq}`));
    },
  };
  return q;
}

// Approvals are Task 04. Until they exist the tests choose which gates count as approved.
function readers(approved: GateId[] = [], feedback: string | null = null): PipelineReaders {
  return { approvedGates: async () => new Set(approved), feedback: async () => feedback };
}

async function stages(videoId: string) {
  const r = await db.pool.query("select id, name, status, input_hash from stage_runs where video_id = $1 order by created_at, id", [videoId]);
  return r.rows as Array<{ id: string; name: string; status: string; input_hash: string }>;
}
/** Runs a queued stage to success the way a worker would (claim, commit). */
async function succeed(stageId: string): Promise<void> {
  const row = (await getStage(db.pool, stageId))!;
  const c = await claimStage(db.pool, { id: stageId, inputHash: row.inputHash, workerId: "w", ttlMs: 60_000 });
  expect(c).not.toBeNull();
  expect(await commitStage(db.pool, c!, { ok: true })).toBe(true);
}
async function draftDone(videoId: string, q: FakeQueue) {
  await advanceVideo(db.pool, q, videoId, readers());
  const [d] = await stages(videoId);
  await succeed(d!.id);
  await addContent(db.pool, videoId, "script", { body: { n: 1 }, sha256: h("a") });
}

describe("advanceVideo", () => {
  it("creates_the_draft_stage_and_enqueues_it_after_commit", async () => {
    const v = await createVideoRow(db.pool, input);
    const q = fakeQueue();
    const r = await advanceVideo(db.pool, q, v.id, readers());
    const rows = await stages(v.id);
    expect(rows.map((s) => [s.name, s.status])).toEqual([["draft", "queued"]]);
    expect(r.enqueued).toEqual([rows[0]!.id]);
    expect(q.calls).toEqual([{ id: rows[0]!.id, fence: 0, attemptSeq: 0, inputHash: rows[0]!.input_hash }]);
  });
  it("waits_at_the_script_gate_then_continues_when_it_is_approved", async () => {
    const v = await createVideoRow(db.pool, input);
    const q = fakeQueue();
    await draftDone(v.id, q);
    expect((await advanceVideo(db.pool, q, v.id, readers())).enqueued).toEqual([]);
    expect((await db.pool.query("select status from videos where id = $1", [v.id])).rows[0].status).toBe("waiting");
    const r = await advanceVideo(db.pool, q, v.id, readers(["script"]));
    expect(r.enqueued).toHaveLength(1);
    expect((await stages(v.id)).map((s) => s.name)).toEqual(["draft", "build"]);
  });
  it("two_concurrent_advances_create_one_stage_row", async () => {
    const v = await createVideoRow(db.pool, input);
    const q = fakeQueue();
    const rs = await Promise.all(Array.from({ length: 12 }, () => advanceVideo(db.pool, q, v.id, readers())));
    expect(await stages(v.id)).toHaveLength(1);
    expect(rs.flatMap((r) => r.enqueued)).toHaveLength(1);
    expect(q.calls).toHaveLength(1);
  });
  it("the_unique_index_alone_stops_a_second_row_for_the_same_stage_and_input", async () => {
    const v = await createVideoRow(db.pool, input);
    await db.pool.query("insert into stage_runs (id, video_id, name, input_hash) values (gen_random_uuid(), $1, 'draft', 'x')", [v.id]);
    await expect(db.pool.query("insert into stage_runs (id, video_id, name, input_hash) values (gen_random_uuid(), $1, 'draft', 'x')", [v.id])).rejects.toThrow(/stage_runs_pipeline_unique/);
    // a failed run does not block a fresh one with the same input
    await db.pool.query("update stage_runs set status = 'failed' where video_id = $1", [v.id]);
    await db.pool.query("insert into stage_runs (id, video_id, name, input_hash) values (gen_random_uuid(), $1, 'draft', 'x')", [v.id]);
  });
  it("advance_sweep_creates_next_stage_once_after_crash_between_commit_and_advance", async () => {
    const v = await createVideoRow(db.pool, input);
    const q = fakeQueue();
    await draftDone(v.id, q); // draft committed, then the process died before advancing: no build row exists
    expect((await stages(v.id)).map((s) => s.name)).toEqual(["draft"]);
    const gates = readers(["script"]);
    const [a, b] = await Promise.all([advanceAll(db.pool, q, gates), advanceAll(db.pool, q, gates)]);
    expect([...a.enqueued, ...b.enqueued]).toHaveLength(1);
    await advanceAll(db.pool, q, gates);
    expect((await stages(v.id)).map((s) => s.name)).toEqual(["draft", "build"]);
  });
  it("enqueue_failure_after_commit_leaves_a_queued_row_the_reconciler_recovers", async () => {
    const v = await createVideoRow(db.pool, input);
    const q = fakeQueue();
    q.failNext = 1;
    const r = await advanceVideo(db.pool, q, v.id, readers());
    expect(r.enqueued).toEqual([]);
    expect(r.enqueueFailed).toHaveLength(1);
    const [row] = await stages(v.id);
    expect(row!.status).toBe("queued");
    expect(q.calls).toHaveLength(0);
    // advancing again must not make a second row
    await advanceVideo(db.pool, q, v.id, readers());
    expect(await stages(v.id)).toHaveLength(1);
    const rec = await reconcile(db.pool, q, { graceMs: 0 });
    expect(rec.reenqueued).toEqual([row!.id]);
    expect(q.calls).toHaveLength(1);
  });
  it("advance_never_touches_post_review_states", async () => {
    const v = await createVideoRow(db.pool, input);
    const q = fakeQueue();
    const all: GateId[] = ["script", "cost", "video", "evidence", "publish"];
    // run the whole route
    for (let i = 0; i < 20; i++) {
      const r = await advanceVideo(db.pool, q, v.id, readers(all));
      if (r.enqueued.length === 0) break;
      await succeed(r.enqueued[0]!);
      const done = (await stages(v.id)).map((s) => s.name);
      if (done.at(-1) === "draft") await addContent(db.pool, v.id, "script", { body: {}, sha256: h("a") });
      if (done.at(-1) === "build") {
        await addContent(db.pool, v.id, "beats", { body: {}, sha256: h("b") });
        await addContent(db.pool, v.id, "cost_plan", { body: { items: [] }, sha256: h("c") });
      }
    }
    const before = await stages(v.id);
    expect(before.map((s) => s.name)).toEqual(["draft", "build", "tts", "render", "voice", "sfx", "qa"]);
    expect((await advanceAll(db.pool, q, readers(all))).enqueued).toEqual([]);
    expect(await stages(v.id)).toEqual(before);
  });
  it("send_back_reruns_the_draft_with_the_feedback_in_the_input", async () => {
    const v = await createVideoRow(db.pool, input);
    const q = fakeQueue();
    await draftDone(v.id, q);
    const first = (await stages(v.id))[0]!;
    const r = await advanceVideo(db.pool, q, v.id, readers([], "shorter hook please"));
    expect(r.enqueued).toHaveLength(1);
    const rows = await stages(v.id);
    expect(rows.map((s) => s.name)).toEqual(["draft", "draft"]);
    expect(rows[1]!.input_hash).not.toBe(first.input_hash);
  });
  it("does_not_advance_cancelled_or_failed_videos", async () => {
    const v = await createVideoRow(db.pool, input);
    await db.pool.query("update videos set status = 'cancelled' where id = $1", [v.id]);
    const q = fakeQueue();
    expect((await advanceVideo(db.pool, q, v.id, readers())).enqueued).toEqual([]);
    expect(await stages(v.id)).toHaveLength(0);
  });
  it("unknown_video_throws", async () => {
    await expect(advanceVideo(db.pool, fakeQueue(), "00000000-0000-4000-8000-000000000000", readers())).rejects.toThrow(/not found/);
  });
});

describe("rerunStage and cancelVideo", () => {
  it("cannot_rerun_while_job_active", async () => {
    const v = await createVideoRow(db.pool, input);
    const q = fakeQueue();
    await advanceVideo(db.pool, q, v.id, readers());
    await expect(rerunStage(db.pool, q, v.id, "draft", readers())).rejects.toThrow(/cannot_rerun_while_job_active/);
  });
  it("rerun_after_a_failure_makes_a_new_row_and_refuses_when_nothing_changed", async () => {
    const v = await createVideoRow(db.pool, input);
    const q = fakeQueue();
    await advanceVideo(db.pool, q, v.id, readers());
    const [d] = await stages(v.id);
    const c = await claimStage(db.pool, { id: d!.id, inputHash: d!.input_hash, workerId: "w", ttlMs: 60_000 });
    await failStage(db.pool, c!, "boom");
    const r = await rerunStage(db.pool, q, v.id, "draft", readers());
    expect(r.enqueued).toHaveLength(1);
    expect((await stages(v.id)).map((s) => s.status)).toEqual(["failed", "queued"]);
    await succeed(r.enqueued[0]!);
    await expect(rerunStage(db.pool, q, v.id, "draft", readers())).rejects.toThrow(/nothing changed/);
  });
  it("cancel_flags_every_active_stage_and_stops_advancing", async () => {
    const v = await createVideoRow(db.pool, input);
    const q = fakeQueue();
    await advanceVideo(db.pool, q, v.id, readers());
    await cancelVideo(db.pool, v.id);
    const row = (await getStage(db.pool, (await stages(v.id))[0]!.id))!;
    expect(["cancelled", "queued"]).toContain(row.status);
    expect(row.status === "cancelled" || row.cancelRequested).toBe(true);
    expect((await db.pool.query("select status from videos where id = $1", [v.id])).rows[0].status).toBe("cancelled");
    expect((await advanceAll(db.pool, q, readers())).enqueued).toEqual([]);
  });
});
