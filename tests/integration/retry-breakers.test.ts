import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildEngineConfig } from "@/server/core/engine-config";
import { NotProcessedError } from "@/server/core/error-class";
import { KnownFailure } from "@/server/core/paid-call";
import { callKey } from "@/server/core/spend";
import type { StageHandler } from "@/server/core/stage-handler";
import type { StageRunnerDeps } from "@/server/core/stage-runner";
import { admitStage, breakerHold, recordBreakerEvent, releaseProbe, resetBreaker } from "@/server/db/breakers";
import { advanceAll, advanceVideo, rerunStage } from "@/server/db/pipeline";
import { reconcile } from "@/server/db/reconciler";
import { afterReconcile, afterStageOutcome, scheduleRetry, sweepRetries } from "@/server/db/retry";
import { setSetting } from "@/server/db/settings";
import { getBudget } from "@/server/db/spend";
import { runStage } from "@/server/db/stage-runner-adapter";
import { claimStage, getStage } from "@/server/db/stages";
import { addContent, createVideoRow } from "@/server/db/videos";
import { createFakeProvider, type FakeProvider } from "../support/fake-provider";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
let provider: FakeProvider;
beforeAll(async () => {
  db = await withTestDb();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  // reset() truncates settings too, so re-seed the engine numbers the way the migration does.
  await db.ownerPool.query(await readFile("src/server/db/migrations/0014_breakers.sql", "utf8"));
  provider = createFakeProvider({ pool: db.pool });
  await provider.init();
  await db.ownerPool.query("truncate fake_provider_calls");
  await db.pool.query("insert into budgets (scope, cap_micro_usd) values ('g', 100000000)");
});

const input = { format: "short", kind: "scene_kit", language: "en", topic: "Why the sky is blue" } as const;
const config = buildEngineConfig(new Map());
const SESSION = { kind: "session", sessionId: "0190f3a2-7c1e-7a55-9d3b-2f6c8a1b4e90" } as const;

interface FakeQueue {
  calls: Array<{ id: string; fence: number; attemptSeq: number; inputHash: string; delayMs?: number }>;
  failNext: number;
  enqueue(id: string, fence: number, attemptSeq: number, inputHash: string, opts?: { delayMs?: number }): Promise<string>;
  liveJobIds(): Promise<Set<string>>;
}
function fakeQueue(): FakeQueue {
  const q: FakeQueue = {
    calls: [],
    failNext: 0,
    async enqueue(id, fence, attemptSeq, inputHash, opts) {
      if (q.failNext > 0) {
        q.failNext--;
        throw new Error("redis down");
      }
      q.calls.push({ id, fence, attemptSeq, inputHash, delayMs: opts?.delayMs });
      return `stage.${id}.${fence}.${attemptSeq}`;
    },
    async liveJobIds() {
      return new Set(q.calls.map((c) => `stage.${c.id}.${c.fence}.${c.attemptSeq}`));
    },
  };
  return q;
}

const refuse429 = () => new NotProcessedError("provider said 429", { status: 429 });
const step = (over = {}) => ({ reserveMicroUsd: 1000, budgetScopes: ["g"], kind: "paid" as const, ...over });
const deps = (handler: StageHandler, over: Partial<StageRunnerDeps> = {}): StageRunnerDeps => ({ provider: { call: (key) => provider.call(key) }, ttlMs: 5000, workerId: "w", handler, config, ...over });
const failWith = (err: unknown): StageHandler => async () => {
  throw err;
};

async function newVideo() {
  return createVideoRow(db.pool, input);
}
async function stagesOf(videoId: string, name?: string) {
  const r = await db.pool.query(
    `select id, name, status, input_hash, retry_of, not_before, result from stage_runs where video_id = $1 ${name ? "and name = $2" : ""} order by created_at, id`,
    name ? [videoId, name] : [videoId],
  );
  return r.rows as Array<{ id: string; name: string; status: string; input_hash: string; retry_of: string | null; not_before: Date | null; result: Record<string, unknown> | null }>;
}
/** Makes the not_before of a queued retry row due, the way time passing (or a Mac sleep) would. */
async function makeDue(stageId: string) {
  await db.ownerPool.query("update stage_runs set not_before = clock_timestamp() - interval '1 second', updated_at = clock_timestamp() - interval '1 minute' where id = $1", [stageId]);
}
/** One worker attempt for a queued stage, then the post-outcome bookkeeping the runtime performs. */
async function attempt(q: FakeQueue, stageId: string, handler: StageHandler) {
  const row = (await getStage(db.pool, stageId))!;
  const outcome = await runStage(db.pool, deps(handler), { stageRunId: stageId, inputHash: row.inputHash });
  const after = "claim" in outcome ? await afterStageOutcome(db.pool, q, { kind: outcome.kind, stageRunId: stageId }) : null;
  return { outcome, after };
}
async function firstDraft(q: FakeQueue) {
  const v = await newVideo();
  await advanceVideo(db.pool, q, v.id);
  const [d] = await stagesOf(v.id, "draft");
  return { v, draftId: d!.id };
}
const latest = async (videoId: string, name = "draft") => (await stagesOf(videoId, name)).at(-1)!;

describe("retry of confirmed provider rejections", () => {
  it("transient_failure_retries_with_30_120_480_waits_using_the_db_clock", async () => {
    await setSetting(db.pool, "engine.retry_attempts", 4, { actor: "session" });
    await setSetting(db.pool, "breaker.threshold", 0, { actor: "session" }); // this test is about the waits, not the breaker
    const q = fakeQueue();
    const { v, draftId } = await firstDraft(q);
    let id = draftId;
    const waits: number[] = [];
    for (const expected of [30_000, 120_000, 480_000]) {
      const { after } = await attempt(q, id, failWith(refuse429()));
      expect(after?.retry).toMatchObject({ kind: "scheduled", delayMs: expected });
      const next = await latest(v.id);
      expect(next.id).not.toBe(id);
      expect(next).toMatchObject({ status: "queued", retry_of: id });
      expect(next.input_hash).toBe((await getStage(db.pool, draftId))!.inputHash);
      // not_before is the DATABASE clock plus the wait
      const gap = Number((await db.pool.query("select extract(epoch from (not_before - clock_timestamp())) as s from stage_runs where id = $1", [next.id])).rows[0].s);
      expect(gap).toBeGreaterThan(expected / 1000 - 5);
      expect(gap).toBeLessThanOrEqual(expected / 1000);
      expect(q.calls.at(-1)).toMatchObject({ id: next.id, delayMs: expected });
      waits.push(expected);
      // not due yet: a worker cannot claim it early, even if a stray job arrives
      expect(await claimStage(db.pool, { id: next.id, inputHash: next.input_hash, workerId: "early", ttlMs: 5000 })).toBeNull();
      await makeDue(next.id);
      id = next.id;
    }
    expect(waits).toEqual([30_000, 120_000, 480_000]);
    // the fourth and last try fails: no fifth row
    const last = await attempt(q, id, failWith(refuse429()));
    expect(last.after?.retry).toMatchObject({ kind: "exhausted" });
    const rows = await stagesOf(v.id, "draft");
    expect(rows.map((r) => r.status)).toEqual(["failed", "failed", "failed", "failed"]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(4);
  });

  it("retries_exhausted_ends_failed_with_a_plain_reason", async () => {
    const q = fakeQueue();
    const { v, draftId } = await firstDraft(q);
    let id = draftId;
    for (let i = 0; i < 2; i++) {
      await attempt(q, id, failWith(refuse429()));
      id = (await latest(v.id)).id;
      await makeDue(id);
    }
    const { after } = await attempt(q, id, failWith(refuse429()));
    expect(after?.retry).toMatchObject({ kind: "exhausted" });
    const rows = await stagesOf(v.id, "draft");
    expect(rows).toHaveLength(3); // engine.retry_attempts = 3 tries in total
    const result = rows[2]!.result as { plain: string; error: string };
    expect(result.plain).toMatch(/3 tries/);
    expect(result.plain).toMatch(/nothing was charged/i);
    // a later sweep does not resurrect it
    expect((await sweepRetries(db.pool, q)).scheduled).toEqual([]);
    expect(await stagesOf(v.id, "draft")).toHaveLength(3);
  });

  it("permanent_failure_is_not_retried_then_a_human_restart_makes_a_new_row", async () => {
    const q = fakeQueue();
    const { v, draftId } = await firstDraft(q);
    const { after } = await attempt(q, draftId, failWith(new NotProcessedError("bad request", { status: 400 })));
    expect(after?.retry).toMatchObject({ kind: "not_retryable", reason: "not_transient" });
    expect(await stagesOf(v.id, "draft")).toHaveLength(1);
    expect((await sweepRetries(db.pool, q)).scheduled).toEqual([]);
    // the owner restarts it: a fresh row (the failed one does not block the unique index)
    const r = await rerunStage(db.pool, q, v.id, "draft");
    expect(r.enqueued).toHaveLength(1);
    expect((await stagesOf(v.id, "draft")).map((s) => s.status)).toEqual(["failed", "queued"]);
  });

  it("a_plain_known_failure_without_the_not_processed_mark_is_not_retried", async () => {
    const q = fakeQueue();
    const { v, draftId } = await firstDraft(q);
    const { after } = await attempt(q, draftId, failWith(new KnownFailure("provider rejected")));
    expect(after?.retry).toMatchObject({ kind: "not_retryable", reason: "not_transient" });
    expect(await stagesOf(v.id, "draft")).toHaveLength(1);
  });

  it("unknown_outcome_is_never_retried_even_for_cheap_text", async () => {
    await setSetting(db.pool, "engine.retry_attempts", 4, { actor: "session" });
    const q = fakeQueue();
    const { v, draftId } = await firstDraft(q);
    const row = (await getStage(db.pool, draftId))!;
    const handler: StageHandler = (ctx) => ctx.paid(step({ kind: "cheap_text" }), async () => {
      throw new Error("socket hang up"); // sent, no answer: the outcome is unknown
    });
    await expect(runStage(db.pool, deps(handler, { ttlMs: 300 }), { stageRunId: draftId, inputHash: row.inputHash })).rejects.toThrow(/socket hang up/);
    await db.ownerPool.query("update stage_runs set lease_until = clock_timestamp() - interval '1 second' where id = $1", [draftId]);
    const rec = await reconcile(db.pool, q, { graceMs: 0 });
    expect(rec.needsDecision).toEqual([draftId]);
    expect((await getStage(db.pool, draftId))!.status).toBe("needs_decision");
    await afterReconcile(db.pool, rec);
    expect(await scheduleRetry(db.pool, q, draftId)).toMatchObject({ kind: "not_retryable" });
    expect((await sweepRetries(db.pool, q)).scheduled).toEqual([]);
    expect(await stagesOf(v.id, "draft")).toHaveLength(1);
    expect(await provider.dbCalls(callKey(draftId, 0, 0))).toBe(0);
  });

  it("a_failed_row_with_an_open_or_paid_intent_is_refused_even_if_marked_transient", async () => {
    const q = fakeQueue();
    const { v, draftId } = await firstDraft(q);
    // step 0 paid and settled, step 1 refused: the retry would pay step 0 again, so it is refused
    const handler: StageHandler = async (ctx) => {
      await ctx.paid(step(), (key) => provider.call(key));
      return ctx.paid(step(), async () => {
        throw refuse429();
      });
    };
    const { after } = await attempt(q, draftId, handler);
    expect(after?.retry).toMatchObject({ kind: "not_retryable", reason: "paid_call_not_cleared" });
    expect(await stagesOf(v.id, "draft")).toHaveLength(1);
    // a hand-forged "transient" mark on a row with a pending intent is refused too
    const v2 = await newVideo();
    await advanceVideo(db.pool, q, v2.id);
    const forged = (await latest(v2.id)).id;
    await db.ownerPool.query("update stage_runs set status = 'failed', result = '{\"error\":\"x\",\"class\":\"transient\"}' where id = $1", [forged]);
    await db.ownerPool.query("insert into spend_intents (id, stage_run_id, step_index, tool_call_index, call_key, status) values (gen_random_uuid(), $1, 0, 0, $2, 'unknown')", [forged, callKey(forged, 0, 0)]);
    expect(await scheduleRetry(db.pool, q, forged)).toMatchObject({ kind: "not_retryable", reason: "paid_call_not_cleared" });
  });

  it("retry_uses_new_call_keys_and_never_reuses_a_failed_known_one", async () => {
    const q = fakeQueue();
    const { v, draftId } = await firstDraft(q);
    const paid = (fail: boolean): StageHandler => (ctx) =>
      ctx.paid(step(), async (key) => {
        if (fail) throw refuse429();
        return provider.call(key);
      });
    const first = await attempt(q, draftId, paid(true));
    expect(first.after?.retry).toMatchObject({ kind: "scheduled" });
    const retryId = (await latest(v.id)).id;
    await makeDue(retryId);
    const second = await attempt(q, retryId, paid(false));
    expect(second.outcome.kind).toBe("committed");
    const oldKey = callKey(draftId, 0, 0);
    const newKey = callKey(retryId, 0, 0);
    expect(newKey).not.toBe(oldKey);
    const intents = (await db.pool.query("select call_key, status from spend_intents order by call_key")).rows;
    expect(intents).toEqual(expect.arrayContaining([{ call_key: oldKey, status: "failed_known" }, { call_key: newKey, status: "done" }]));
    expect(await provider.dbCalls(oldKey)).toBe(0);
    expect(await provider.dbCalls(newKey)).toBe(1);
    expect((await getBudget(db.pool, "g"))!.reservedMicroUsd).toBe(0);
  });

  it("a_retry_whose_input_went_stale_is_not_scheduled", async () => {
    const q = fakeQueue();
    const { v, draftId } = await firstDraft(q);
    const row = (await getStage(db.pool, draftId))!;
    const outcome = await runStage(db.pool, deps(failWith(refuse429())), { stageRunId: draftId, inputHash: row.inputHash });
    expect(outcome.kind).toBe("known_failure");
    // the owner sends back with a note before the retry was scheduled: the hash the row was run for no longer applies
    const readers = { approvedGates: async () => new Set<never>(), feedback: async () => "make it shorter" };
    expect(await scheduleRetry(db.pool, q, draftId, readers)).toMatchObject({ kind: "not_retryable", reason: "stale_input" });
    expect(await stagesOf(v.id, "draft")).toHaveLength(1);
  });

  it("a_503_even_when_marked_not_processed_is_unclear_and_never_retried", async () => {
    const q = fakeQueue();
    const { v, draftId } = await firstDraft(q);
    const { after } = await attempt(q, draftId, failWith(new NotProcessedError("bad gateway", { status: 503 })));
    expect(after?.retry).toMatchObject({ kind: "not_retryable", reason: "not_transient" });
    expect(await stagesOf(v.id, "draft")).toHaveLength(1);
  });

  it("permanently_refused_rows_are_marked_and_cannot_starve_the_sweep", async () => {
    const q = fakeQueue();
    // an old row that can never be retried (a paid call is not cleared), then a real one behind it
    const a = await newVideo();
    await advanceVideo(db.pool, q, a.id);
    const stuck = (await latest(a.id)).id;
    await db.ownerPool.query("update stage_runs set status = 'failed', result = '{\"error\":\"x\",\"class\":\"transient\"}' where id = $1", [stuck]);
    await db.ownerPool.query("insert into spend_intents (id, stage_run_id, step_index, tool_call_index, call_key, status) values (gen_random_uuid(), $1, 0, 0, $2, 'unknown')", [stuck, callKey(stuck, 0, 0)]);
    const { v: b, draftId } = await firstDraft(q);
    const row = (await getStage(db.pool, draftId))!;
    await runStage(db.pool, deps(failWith(refuse429())), { stageRunId: draftId, inputHash: row.inputHash }); // worker died before scheduling
    const first = await sweepRetries(db.pool, q, undefined, { limit: 1 });
    expect(first.gaveUp).toEqual([stuck]);
    expect(first.scheduled).toEqual([]);
    expect((await getStage(db.pool, stuck))!.result).toMatchObject({ retry_refused: "paid_call_not_cleared" });
    // the refused row is not looked at again, so the real one is reached even with a limit of 1
    const second = await sweepRetries(db.pool, q, undefined, { limit: 1 });
    expect(second.scheduled).toHaveLength(1);
    expect(second.gaveUp).toEqual([]);
    expect((await stagesOf(b.id, "draft")).map((s) => s.status)).toEqual(["failed", "queued"]);
    expect((await sweepRetries(db.pool, q)).gaveUp).toEqual([]);
  });

  it("a_swept_row_that_ran_out_of_retries_is_reported_as_given_up_once", async () => {
    await setSetting(db.pool, "engine.retry_attempts", 1, { actor: "session" });
    const q = fakeQueue();
    const { draftId } = await firstDraft(q);
    const row = (await getStage(db.pool, draftId))!;
    await runStage(db.pool, deps(failWith(refuse429())), { stageRunId: draftId, inputHash: row.inputHash });
    expect((await sweepRetries(db.pool, q)).gaveUp).toEqual([draftId]);
    expect((await sweepRetries(db.pool, q)).gaveUp).toEqual([]);
  });

  it("a_failed_row_the_owner_already_restarted_is_not_retried_again", async () => {
    const q = fakeQueue();
    const { v, draftId } = await firstDraft(q);
    const row = (await getStage(db.pool, draftId))!;
    await runStage(db.pool, deps(failWith(refuse429())), { stageRunId: draftId, inputHash: row.inputHash });
    await rerunStage(db.pool, q, v.id, "draft"); // the owner pressed rerun before the retry was scheduled
    expect(await scheduleRetry(db.pool, q, draftId)).toMatchObject({ kind: "not_retryable", reason: "superseded" });
    expect((await sweepRetries(db.pool, q)).scheduled).toEqual([]);
    expect(await stagesOf(v.id, "draft")).toHaveLength(2);
  });

  it("two_schedulers_racing_make_exactly_one_retry_row", async () => {
    const q = fakeQueue();
    const { v, draftId } = await firstDraft(q);
    await attempt(q, draftId, failWith(refuse429()));
    await db.ownerPool.query("delete from stage_runs where retry_of = $1", [draftId]); // pretend the process died before the row existed
    await Promise.all([1, 2, 3, 4].map(() => scheduleRetry(db.pool, q, draftId)));
    expect((await stagesOf(v.id, "draft")).filter((r) => r.retry_of === draftId)).toHaveLength(1);
  });

  it("a_crash_between_fail_and_schedule_is_repaired_by_the_sweep", async () => {
    const q = fakeQueue();
    const { v, draftId } = await firstDraft(q);
    const row = (await getStage(db.pool, draftId))!;
    await runStage(db.pool, deps(failWith(refuse429())), { stageRunId: draftId, inputHash: row.inputHash }); // no afterStageOutcome: the worker died
    expect(await stagesOf(v.id, "draft")).toHaveLength(1);
    const swept = await sweepRetries(db.pool, q);
    expect(swept.scheduled).toHaveLength(1);
    expect((await stagesOf(v.id, "draft")).map((s) => s.status)).toEqual(["failed", "queued"]);
  });
});

describe("not_before and the queue", () => {
  it("advance_ignores_the_waiting_row_until_it_is_due", async () => {
    const q = fakeQueue();
    const { v, draftId } = await firstDraft(q);
    await attempt(q, draftId, failWith(refuse429()));
    const before = q.calls.length;
    const r = await advanceVideo(db.pool, q, v.id);
    expect(r.action).toMatchObject({ kind: "wait_stage", stage: "draft", status: "queued" });
    expect(r.enqueued).toEqual([]);
    expect(q.calls).toHaveLength(before);
  });

  it("not_before_survives_a_redis_wipe_and_a_mac_sleep", async () => {
    const q = fakeQueue();
    const { v, draftId } = await firstDraft(q);
    await attempt(q, draftId, failWith(refuse429()));
    const retry = await latest(v.id);
    q.calls.length = 0; // Redis wiped: the delayed job is gone
    const early = await reconcile(db.pool, q, { graceMs: 0 });
    expect(early.reenqueued).toEqual([]); // not due: nothing is started early
    expect(q.calls).toHaveLength(0);
    // time passes (a sleeping Mac); only database timestamps move
    await makeDue(retry.id);
    const late = await reconcile(db.pool, q, { graceMs: 0 });
    expect(late.reenqueued).toEqual([retry.id]);
    expect(q.calls[0]).toMatchObject({ id: retry.id, inputHash: retry.input_hash });
    expect(await claimStage(db.pool, { id: retry.id, inputHash: retry.input_hash, workerId: "w", ttlMs: 5000 })).not.toBeNull();
  });
});

describe("breaker wiring", () => {
  // Three videos fail draft for a permanent reason (no retry noise): the breaker counts consecutive terminal failures.
  async function openDraftBreaker(q: FakeQueue) {
    let opened: unknown;
    for (let i = 0; i < 3; i++) {
      const { draftId } = await firstDraft(q);
      const { after } = await attempt(q, draftId, failWith(new NotProcessedError("bad request", { status: 400 })));
      opened = after?.breakerOpened;
    }
    return opened;
  }

  it("breaker_opens_after_three_failures_and_holds_new_stages", async () => {
    const q = fakeQueue();
    const opened = await openDraftBreaker(q);
    expect(opened).toMatchObject({ stage: "draft" });
    const v = await newVideo();
    const r = await advanceVideo(db.pool, q, v.id);
    expect(r.enqueued).toEqual([]);
    expect(r.held).toMatchObject({ stage: "draft" });
    expect(r.held!.until!.getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);
    expect(await stagesOf(v.id)).toEqual([]); // no row: the video simply waits
    expect(await breakerHold(db.pool, "draft")).not.toBeNull();
    // the sweep keeps it quiet too
    const sweep = await advanceAll(db.pool, q);
    expect(sweep.enqueued).toEqual([]);
    // an explicit rerun is refused the same way
    const vf = (await db.pool.query("select video_id from stage_runs where name = 'draft' limit 1")).rows[0].video_id as string;
    const rr = await rerunStage(db.pool, q, vf, "draft");
    expect(rr.enqueued).toEqual([]);
    expect(rr.held).toMatchObject({ stage: "draft" });
  });

  it("other_stages_are_unaffected", async () => {
    const q = fakeQueue();
    await openDraftBreaker(q);
    expect(await breakerHold(db.pool, "build")).toBeNull();
    expect(await breakerHold(db.pool, "voice")).toBeNull();
    expect(await breakerHold(db.pool, "tts")).toBeNull(); // not a guarded stage at all
    // a video whose draft already succeeded still goes on to build while draft is held
    const v = await newVideo();
    const row = (await db.ownerPool.query("update breakers set status = 'closed', failures = 0, opened_at = null where stage = 'draft' returning 1")).rowCount;
    expect(row).toBe(1);
    const readers = { approvedGates: async () => new Set(["script" as const]), feedback: async () => null };
    await advanceVideo(db.pool, q, v.id, readers);
    const d = await latest(v.id);
    await runStage(db.pool, deps(async () => ({ ok: true })), { stageRunId: d.id, inputHash: d.input_hash });
    await addContent(db.pool, v.id, "script", { body: { n: 1 }, sha256: "a".repeat(64) });
    await db.ownerPool.query("update breakers set status = 'open', failures = 3, opened_at = clock_timestamp() where stage = 'draft'");
    const r = await advanceVideo(db.pool, q, v.id, readers);
    expect(r.enqueued).toHaveLength(1);
    expect((await latest(v.id, "build")).status).toBe("queued");
  });

  it("cooldown_to_half_open_to_closed", async () => {
    const q = fakeQueue();
    await openDraftBreaker(q);
    await db.ownerPool.query("update breakers set opened_at = clock_timestamp() - interval '901 seconds' where stage = 'draft'");
    // half open: of two waiting videos exactly one probe passes
    const a = await newVideo();
    const b = await newVideo();
    const [ra, rb] = await Promise.all([advanceVideo(db.pool, q, a.id), advanceVideo(db.pool, q, b.id)]);
    expect([ra.enqueued.length, rb.enqueued.length].sort()).toEqual([0, 1]);
    const probe = ra.enqueued.length === 1 ? ra : rb;
    const held = ra.enqueued.length === 1 ? rb : ra;
    expect(held.held).toMatchObject({ stage: "draft" });
    // the probe succeeds: breaker closes and the other video goes through
    const probeId = probe.enqueued[0]!;
    const row = (await getStage(db.pool, probeId))!;
    const out = await runStage(db.pool, deps(async () => ({ ok: true })), { stageRunId: probeId, inputHash: row.inputHash });
    const after = await afterStageOutcome(db.pool, q, { kind: out.kind, stageRunId: probeId });
    expect(after.breakerOpened).toBeUndefined();
    expect(await breakerHold(db.pool, "draft")).toBeNull();
    const again = await advanceAll(db.pool, q);
    expect(again.enqueued).toHaveLength(1);
  });

  it("a_failed_probe_reopens_with_a_fresh_cooldown", async () => {
    const q = fakeQueue();
    await openDraftBreaker(q);
    await db.ownerPool.query("update breakers set opened_at = clock_timestamp() - interval '901 seconds' where stage = 'draft'");
    const a = await newVideo();
    const r = await advanceVideo(db.pool, q, a.id);
    const probeId = r.enqueued[0]!;
    const { after } = await attempt(q, probeId, failWith(new NotProcessedError("bad request", { status: 400 })));
    expect(after?.breakerOpened).toMatchObject({ stage: "draft" });
    const b = await newVideo();
    expect((await advanceVideo(db.pool, q, b.id)).held).toMatchObject({ stage: "draft" });
  });

  it("a_probe_that_never_reports_ages_out_after_one_more_cooldown", async () => {
    const q = fakeQueue();
    await openDraftBreaker(q);
    await db.ownerPool.query("update breakers set opened_at = clock_timestamp() - interval '901 seconds' where stage = 'draft'");
    expect((await advanceVideo(db.pool, q, (await newVideo()).id)).enqueued).toHaveLength(1);
    expect((await advanceVideo(db.pool, q, (await newVideo()).id)).enqueued).toHaveLength(0);
    await db.ownerPool.query("update breakers set probe_at = clock_timestamp() - interval '901 seconds' where stage = 'draft'");
    expect((await advanceVideo(db.pool, q, (await newVideo()).id)).enqueued).toHaveLength(1);
  });

  it("a_held_retry_waits_for_the_breaker_instead_of_being_lost", async () => {
    const q = fakeQueue();
    const { v, draftId } = await firstDraft(q); // admitted while the breaker was closed
    await openDraftBreaker(q);
    const row = (await getStage(db.pool, draftId))!;
    await runStage(db.pool, deps(failWith(refuse429())), { stageRunId: draftId, inputHash: row.inputHash });
    expect(await scheduleRetry(db.pool, q, draftId)).toMatchObject({ kind: "held", stage: "draft" });
    expect(await stagesOf(v.id, "draft")).toHaveLength(1);
    await db.ownerPool.query("update breakers set opened_at = clock_timestamp() - interval '901 seconds' where stage = 'draft'");
    expect((await sweepRetries(db.pool, q)).scheduled).toHaveLength(1);
  });

  it("the_half_open_probe_slot_is_given_back_when_no_row_is_created", async () => {
    const q = fakeQueue();
    await openDraftBreaker(q);
    await db.ownerPool.query("update breakers set opened_at = clock_timestamp() - interval '901 seconds' where stage = 'draft'");
    expect(await admitStage(db.pool, "draft")).toEqual({ allowed: true, probe: true });
    expect(await admitStage(db.pool, "draft")).toMatchObject({ allowed: false });
    await releaseProbe(db.pool, "draft");
    expect(await admitStage(db.pool, "draft")).toEqual({ allowed: true, probe: true });
  });

  it("a_reset_and_its_audit_row_commit_together_or_not_at_all", async () => {
    const q = fakeQueue();
    await openDraftBreaker(q);
    await expect(recordBreakerEvent(db.pool, "draft", "reset", async () => { throw new Error("audit failed"); })).rejects.toThrow(/audit failed/);
    expect(await breakerHold(db.pool, "draft")).not.toBeNull(); // still open
    expect((await db.pool.query("select 1 from audit_log where event = 'breaker.reset'")).rowCount).toBe(0);
  });

  it("only_the_owner_session_can_reset_a_breaker_and_it_is_audited", async () => {
    const q = fakeQueue();
    await openDraftBreaker(q);
    for (const bad of [{ kind: "token" }, { kind: "job" }, { kind: "system" }, null, { kind: "session" }, { kind: "session", sessionId: "not-a-uuid" }]) {
      expect(await resetBreaker(db.pool, "draft", bad as never)).toMatchObject({ ok: false });
    }
    expect(await breakerHold(db.pool, "draft")).not.toBeNull();
    expect(await resetBreaker(db.pool, "nonsense", SESSION)).toMatchObject({ ok: false });
    expect(await resetBreaker(db.pool, "draft", SESSION)).toEqual({ ok: true });
    expect(await breakerHold(db.pool, "draft")).toBeNull();
    const audit = (await db.pool.query("select detail from audit_log where event = 'breaker.reset'")).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].detail).toMatchObject({ stage: "draft" });
    expect((await advanceVideo(db.pool, q, (await newVideo()).id)).enqueued).toHaveLength(1);
  });

  it("needs_decision_and_timeouts_count_as_failures_but_a_budget_refusal_does_not", async () => {
    const q = fakeQueue();
    for (let i = 0; i < 3; i++) {
      const { draftId } = await firstDraft(q);
      await afterStageOutcome(db.pool, q, { kind: "budget_refused", stageRunId: draftId });
    }
    expect(await breakerHold(db.pool, "draft")).toBeNull();
    for (let i = 0; i < 3; i++) {
      const { draftId } = await firstDraft(q);
      await afterStageOutcome(db.pool, q, { kind: "needs_decision", stageRunId: draftId });
    }
    expect(await breakerHold(db.pool, "draft")).not.toBeNull();
  });
});

describe("load", () => {
  it("thirty_queued_topics_all_reach_review_under_the_caps", async () => {
    // 30 drafts, each one paid call of 1000 micro-USD against a cap of exactly 30000. Every 5th draft is refused once
    // (confirmed, nothing charged) and succeeds on its retry. Nothing is charged twice and every video reaches the script gate.
    await db.pool.query("update budgets set cap_micro_usd = 30000 where scope = 'g'");
    const q = fakeQueue();
    const videos = [];
    for (let i = 0; i < 30; i++) videos.push(await createVideoRow(db.pool, { ...input, topic: `Topic ${i}` }));
    await advanceAll(db.pool, q);
    const flaky = new Set<string>();
    const draftFor = (videoId: string): StageHandler => async (ctx) => {
      const r = await ctx.paid(step(), async (key) => {
        if (flaky.has(videoId)) {
          flaky.delete(videoId);
          throw refuse429();
        }
        return { ...(await provider.call(key)), actualMicroUsd: 1000 };
      });
      await addContent(db.pool, videoId, "script", { body: { text: "script" }, sha256: videoId.replace(/-/g, "").repeat(2).slice(0, 64) });
      return r;
    };
    videos.forEach((v, i) => { if (i % 5 === 4) flaky.add(v.id); });
    for (let round = 0; round < 4; round++) {
      const queued = (await db.pool.query("select id, video_id, input_hash from stage_runs where status = 'queued' order by created_at, id")).rows as Array<{ id: string; video_id: string; input_hash: string }>;
      for (const s of queued) {
        await makeDue(s.id);
        const out = await runStage(db.pool, deps(draftFor(s.video_id)), { stageRunId: s.id, inputHash: s.input_hash });
        await afterStageOutcome(db.pool, q, { kind: out.kind, stageRunId: s.id });
      }
      await advanceAll(db.pool, q);
    }
    const waiting = (await db.pool.query("select count(*)::int n from videos where status = 'waiting'")).rows[0].n as number;
    expect(waiting).toBe(30);
    const budget = (await getBudget(db.pool, "g"))!;
    expect(budget.spentMicroUsd).toBe(30_000);
    expect(budget.reservedMicroUsd).toBe(0);
    expect((await db.pool.query("select count(*)::int n from fake_provider_calls")).rows[0].n).toBe(30);
    expect(await breakerHold(db.pool, "draft")).toBeNull();
  }, 120_000);
});
