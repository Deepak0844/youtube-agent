import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { Queue } from "bullmq";
import { createJobQueue, type JobQueue } from "@/server/queue/job-queue";
import { reconcile } from "@/server/db/reconciler";
import { runStage } from "@/server/db/stage-runner-adapter";
import { claimStage, commitStage, getStage, insertQueuedStage, requestCancel, type Claim } from "@/server/db/stages";
import { getBudget, reserveIntent } from "@/server/db/spend";
import { stageJobId } from "@/server/core/job-id";
import { callKey } from "@/server/core/spend";
import { uuidv7 } from "@/server/core/ids";
import type { StageOutcome, StageRunnerDeps } from "@/server/core/stage-runner";
import { createFakeProvider, type FakeProvider } from "../support/fake-provider";
import { withTestDb, type TestDb } from "../support/db";
import { ONE_STEP, waitFor } from "./helpers/stage-env";

let db: TestDb;
let provider: FakeProvider;
let queue: JobQueue;
let queueName: string;
let closers: Array<() => Promise<void>> = [];
let queueN = 0;

beforeAll(async () => {
  db = await withTestDb();
});
beforeEach(async () => {
  await db.reset();
  provider = createFakeProvider({ pool: db.pool });
  await provider.init();
  await db.ownerPool.query("truncate fake_provider_calls");
  await db.pool.query("insert into budgets (scope, cap_micro_usd) values ('g', 100000000)");
  const suffix = `reconciler-${process.pid}-${queueN++}`;
  queueName = `stages-${suffix}`;
  queue = createJobQueue(db.redisUrl, "stages", suffix);
  closers = [() => queue.close()];
});
afterEach(async () => {
  for (const close of closers.reverse()) await close();
});
afterAll(async () => {
  await db?.stop();
});

const H = "h1";
const NONE = { requeued: [], reenqueued: [], needsDecision: [] };

function deps(workerId: string): StageRunnerDeps {
  return { provider: { call: (key) => provider.call(key) }, ttlMs: 60_000, workerId, stepsFor: () => ONE_STEP };
}
function startRunner(outcomes: StageOutcome[], workerId = "w"): void {
  const w = queue.startWorker(async (job) => {
    outcomes.push(await runStage(db.pool, deps(workerId), job));
  });
  closers.push(() => w.close());
}
async function newStage(): Promise<string> {
  return insertQueuedStage(db.pool, { videoId: uuidv7(), name: "script", inputHash: H });
}
async function claim(id: string, ttlMs = 60_000): Promise<Claim> {
  const c = await claimStage(db.pool, { id, inputHash: H, workerId: "w0", ttlMs });
  if (!c) throw new Error("claim failed");
  return c;
}
async function expireLease(id: string): Promise<void> {
  await db.pool.query("update stage_runs set lease_until = clock_timestamp() - interval '1 second' where id = $1", [id]);
}
async function ageRow(id: string): Promise<void> {
  await db.pool.query("update stage_runs set updated_at = clock_timestamp() - interval '1 hour' where id = $1", [id]);
}
const reserve = (c: Claim, stepIndex = 0) =>
  reserveIntent(db.pool, c, { stepIndex, toolCallIndex: 0, reserveMicroUsd: 1000, budgetScopes: ["g"] });

describe("reconciler", () => {
  it("reconciler_treats_unknown_like_pending", async () => {
    // death between markUnknown and markStageNeedsDecision leaves running + unknown
    const id = await newStage();
    const c = await claim(id);
    expect((await reserve(c)).kind).toBe("new");
    await db.pool.query("update spend_intents set status='unknown' where stage_run_id=$1", [id]);
    await expireLease(id);
    expect(await reconcile(db.pool, queue, { graceMs: 0 })).toMatchObject({ ...NONE, needsDecision: [id] });
    expect((await getStage(db.pool, id))?.status).toBe("needs_decision");
    const { rows } = await db.pool.query("select status from spend_intents where stage_run_id=$1", [id]);
    expect(rows).toEqual([{ status: "unknown" }]);
    expect((await getBudget(db.pool, "g"))?.reservedMicroUsd).toBe(1000);
    expect((await queue.liveJobIds()).size).toBe(0);
  });

  it("expired_stage_with_only_done_and_failed_known_intents_is_requeued", async () => {
    const id = await newStage();
    const c = await claim(id);
    for (const [i, s] of (["done", "failed_known"] as const).entries()) {
      expect((await reserve(c, i)).kind).toBe("new");
      await db.pool.query("update spend_intents set status=$2 where stage_run_id=$1 and step_index=$3", [id, s, i]);
    }
    await expireLease(id);
    expect(await reconcile(db.pool, queue)).toMatchObject({ ...NONE, requeued: [id] });
    expect(await getStage(db.pool, id)).toMatchObject({ status: "queued", fence: 1, attemptSeq: 1, attemptJobId: stageJobId(id, 1, 1) });
    expect(await queue.liveJobIds()).toEqual(new Set([stageJobId(id, 1, 1)]));
  });

  it("running_stage_with_live_lease_is_left_alone", async () => {
    const id = await newStage();
    await claim(id);
    await ageRow(id);
    const before = await getStage(db.pool, id);
    expect(await reconcile(db.pool, queue, { graceMs: 0 })).toMatchObject(NONE);
    expect(await getStage(db.pool, id)).toEqual(before);
  });

  it("reconciler_locks_stage_before_checking_intents", async () => {
    // Forces the dangerous interleaving every round: a reserve has taken its FOR SHARE on a live lease and inserted
    // its intent (uncommitted); the lease then expires; the reconciler starts and must block on the stage row; the
    // reserve commits. The reconciler must then see the pending intent: needs_decision, never queued.
    const blocker = await db.pool.connect();
    try {
      for (let round = 0; round < 30; round++) {
        const id = await newStage();
        const c = await claim(id, 150);
        await blocker.query("begin");
        expect((await reserveIntent(blocker, c, { stepIndex: 0, toolCallIndex: 0, reserveMicroUsd: 1000, budgetScopes: ["g"] })).kind).toBe("new");
        await waitFor(async () => {
          const { rows } = await db.pool.query("select lease_until < clock_timestamp() as expired from stage_runs where id=$1", [id]);
          return rows[0].expired === true;
        }, "lease expired on the DB clock");
        const rec = reconcile(db.pool, queue, { graceMs: 0 });
        await waitFor(async () => {
          const { rows } = await db.pool.query(
            "select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%stage_runs%'",
          );
          return rows[0].n > 0;
        }, "reconciler blocked on the stage row");
        await blocker.query("commit");
        const r = await rec;
        expect(r, `round ${round}`).toMatchObject({ ...NONE, needsDecision: [id] });
        expect((await getStage(db.pool, id))?.status, `round ${round}`).toBe("needs_decision");
      }
    } finally {
      await blocker.query("rollback").catch(() => {});
      blocker.release();
    }
  });

  it("stage_that_commits_while_the_reconciler_waits_is_not_requeued", async () => {
    // The reconciler's candidate scan sees running+expired; before it gets the row lock the (late but still
    // fence-valid) worker commits. The requeue must re-check under the lock and leave the succeeded row alone.
    const blocker = await db.pool.connect();
    try {
      const id = await newStage();
      const c = await claim(id);
      await expireLease(id);
      await blocker.query("begin");
      await blocker.query("select 1 from stage_runs where id = $1 for update", [id]);
      const rec = reconcile(db.pool, queue, { graceMs: 0 });
      await waitFor(async () => {
        const { rows } = await db.pool.query(
          "select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%stage_runs%'",
        );
        return rows[0].n > 0;
      }, "reconciler blocked on the stage row");
      expect(await commitStage(blocker, c, { late: true })).toBe(true);
      await blocker.query("commit");
      expect(await rec).toMatchObject(NONE);
      expect(await getStage(db.pool, id)).toMatchObject({ status: "succeeded", attemptSeq: 0, result: { late: true } });
      expect((await queue.liveJobIds()).size).toBe(0);
    } finally {
      await blocker.query("rollback").catch(() => {});
      blocker.release();
    }
  });

  it("reconcile_is_idempotent_when_run_twice_concurrently", async () => {
    const pool2 = new pg.Pool({ connectionString: db.pool.options.connectionString, max: 10 });
    try {
      for (let round = 0; round < 10; round++) {
        await db.reset();
        await db.pool.query("insert into budgets (scope, cap_micro_usd) values ('g', 100000000)");
        const expired: string[] = [];
        const orphaned: string[] = [];
        for (let i = 0; i < 4; i++) {
          const a = await newStage();
          await claim(a);
          await expireLease(a);
          expired.push(a);
          const b = await newStage();
          await ageRow(b);
          orphaned.push(b);
        }
        // A real grace window: a row one reconciler has just requeued (committed, enqueue not yet sent) must not
        // look orphaned to the other. The orphaned rows are an hour old.
        const [r1, r2] = await Promise.all([reconcile(db.pool, queue, { graceMs: 2000 }), reconcile(pool2, queue, { graceMs: 2000 })]);
        const requeued = [...r1.requeued, ...r2.requeued].sort();
        const reenqueued = [...r1.reenqueued, ...r2.reenqueued].sort();
        expect(requeued, `round ${round}`).toEqual([...expired].sort());
        expect(reenqueued, `round ${round}`).toEqual([...orphaned].sort());
        const expectedLive = new Set([...expired.map((id) => stageJobId(id, 1, 1)), ...orphaned.map((id) => stageJobId(id, 0, 1))]);
        expect(await queue.liveJobIds(), `round ${round}`).toEqual(expectedLive);
        for (const id of [...expired, ...orphaned]) expect((await getStage(db.pool, id))?.attemptSeq, `round ${round}`).toBe(1);
      }
    } finally {
      await pool2.end();
    }
  });

  it("queued_row_with_live_job_is_left_alone", async () => {
    const id = await newStage();
    await queue.enqueue(id, 0, 0, H);
    await ageRow(id);
    const before = await getStage(db.pool, id);
    expect(await reconcile(db.pool, queue, { graceMs: 0 })).toMatchObject(NONE);
    expect(await getStage(db.pool, id)).toEqual(before);
    expect(await queue.liveJobIds()).toEqual(new Set([stageJobId(id, 0, 0)]));
  });

  it("queued_row_with_failed_job_in_redis_is_reenqueued_with_new_attempt_id", async () => {
    const id = await newStage();
    // a worker that fails the job without claiming: the job is kept as failed (removeOnFail: false)
    const failing = queue.startWorker(async () => {
      throw new Error("worker crashed before claiming");
    }, { onError: () => {} });
    await queue.enqueue(id, 0, 0, H);
    const inspect = new Queue(queueName, { connection: { url: db.redisUrl } });
    try {
      await waitFor(async () => (await inspect.getJobState(stageJobId(id, 0, 0))) === "failed", "job failed");
      await failing.close();
      await ageRow(id);
      expect(await reconcile(db.pool, queue, { graceMs: 0 })).toMatchObject({ ...NONE, reenqueued: [id] });
      expect(await getStage(db.pool, id)).toMatchObject({ status: "queued", attemptSeq: 1, attemptJobId: stageJobId(id, 0, 1) });
      expect(await inspect.getJobState(stageJobId(id, 0, 0))).toBe("failed"); // the old one is still there
      const outcomes: StageOutcome[] = [];
      startRunner(outcomes);
      await waitFor(async () => (await getStage(db.pool, id))?.status === "succeeded", "new attempt ran");
      expect(await provider.dbCalls(callKey(id, 0, 0))).toBe(1);
    } finally {
      await inspect.close();
    }
  });

  it("grace_window_prevents_double_enqueue_of_fresh_rows", async () => {
    // creator: insertQueuedStage ... (reconciler runs here) ... enqueue
    const id = await newStage();
    expect(await reconcile(db.pool, queue)).toMatchObject(NONE); // default grace: a fresh row is not touched
    await queue.enqueue(id, 0, 0, H);
    expect(await reconcile(db.pool, queue, { graceMs: 0 })).toMatchObject(NONE);
    expect(await queue.liveJobIds()).toEqual(new Set([stageJobId(id, 0, 0)]));

    // even if the window is too short and both enqueue, the fenced claim runs the stage once
    const id2 = await newStage();
    expect((await reconcile(db.pool, queue, { graceMs: 0 })).reenqueued).toEqual([id2]);
    await queue.enqueue(id2, 0, 0, H); // the creator's late enqueue
    const outcomes: StageOutcome[] = [];
    startRunner(outcomes, "w1");
    startRunner(outcomes, "w2");
    await waitFor(() => outcomes.length === 3, "all deliveries handled"); // id's job + id2's two jobs
    expect(await provider.dbCalls(callKey(id2, 0, 0))).toBe(1);
    expect(await provider.dbCalls(callKey(id, 0, 0))).toBe(1);
    expect(outcomes.filter((o) => o.kind === "committed")).toHaveLength(2);
  });

  it("enqueue_failure_after_requeue_leaves_row_queued_and_is_recovered_once", async () => {
    const id = await newStage();
    await claim(id);
    await expireLease(id);
    const order: string[] = [];
    const broken = {
      liveJobIds: () => queue.liveJobIds(),
      enqueue: async () => {
        // DB commit must already be visible when the enqueue runs
        order.push((await getStage(db.pool, id))!.status);
        throw new Error("redis down");
      },
    };
    const r = await reconcile(db.pool, broken);
    expect(r).toMatchObject({ requeued: [id], reenqueued: [], needsDecision: [], enqueueFailed: [id] });
    expect(order).toEqual(["queued"]);
    expect(await getStage(db.pool, id)).toMatchObject({ status: "queued", attemptSeq: 1 });
    expect((await queue.liveJobIds()).size).toBe(0);

    expect(await reconcile(db.pool, queue)).toMatchObject(NONE); // inside the grace window
    expect(await reconcile(db.pool, queue, { graceMs: 0 })).toMatchObject({ ...NONE, reenqueued: [id] });
    expect(await reconcile(db.pool, queue, { graceMs: 0 })).toMatchObject(NONE);
    expect(await queue.liveJobIds()).toEqual(new Set([stageJobId(id, 1, 2)]));
  });

  it("queued_row_over_max_attempts_with_pending_intent_is_parked_not_failed", async () => {
    for (const intentStatus of ["pending", "unknown"]) {
      const id = await newStage();
      const c = await claim(id);
      expect((await reserve(c)).kind).toBe("new");
      await db.pool.query("update spend_intents set status=$2 where stage_run_id=$1", [id, intentStatus]);
      // abnormal shape (queued with an open intent): must never be failed, that would hide held money
      await db.pool.query(
        "update stage_runs set status='queued', lease_owner=NULL, lease_until=NULL, attempt_seq=3 where id=$1",
        [id],
      );
      await ageRow(id);
      expect(await reconcile(db.pool, queue, { graceMs: 0, maxAttempts: 3 }), intentStatus).toMatchObject({
        ...NONE,
        needsDecision: [id],
        failed: [],
      });
      expect((await getStage(db.pool, id))?.status, intentStatus).toBe("needs_decision");
      const { rows } = await db.pool.query("select status from spend_intents where stage_run_id=$1", [id]);
      expect(rows, intentStatus).toEqual([{ status: "unknown" }]);
      expect((await queue.liveJobIds()).size).toBe(0);
    }
    expect((await getBudget(db.pool, "g"))?.reservedMicroUsd).toBe(2000);
  });

  it("queued_row_over_max_attempts_without_open_intent_still_fails", async () => {
    const id = await newStage();
    await db.pool.query("update stage_runs set attempt_seq=3 where id=$1", [id]);
    await ageRow(id);
    expect(await reconcile(db.pool, queue, { graceMs: 0, maxAttempts: 3 })).toMatchObject({ ...NONE, failed: [id] });
    expect((await getStage(db.pool, id))?.status).toBe("failed");
  });

  it("reconciler_cancels_queued_rows_with_cancel_requested_and_enqueues_nothing", async () => {
    const id = await newStage();
    await requestCancel(db.pool, id);
    await ageRow(id);
    expect(await reconcile(db.pool, queue, { graceMs: 0 })).toMatchObject({ ...NONE, cancelled: [id] });
    expect(await getStage(db.pool, id)).toMatchObject({ status: "cancelled", cancelRequested: true });
    expect((await queue.liveJobIds()).size).toBe(0);
    // inside the grace window too: a cancel never needs to wait
    const fresh = await newStage();
    await requestCancel(db.pool, fresh);
    expect(await reconcile(db.pool, queue)).toMatchObject({ cancelled: [fresh] });
  });

  it("a_cancelled_queued_row_delivered_late_is_a_noop_and_spends_nothing", async () => {
    const id = await newStage();
    await requestCancel(db.pool, id);
    const outcomes: StageOutcome[] = [];
    startRunner(outcomes);
    await queue.enqueue(id, 0, 0, H);
    await waitFor(() => outcomes.length === 1, "delivery handled");
    expect(outcomes[0]).toEqual({ kind: "noop" });
    expect(await provider.dbCalls(callKey(id, 0, 0))).toBe(0);
  });

  it("queued_row_with_flag_and_open_intent_is_parked_by_the_reconciler", async () => {
    const id = await newStage();
    const c = await claim(id);
    expect((await reserve(c)).kind).toBe("new");
    await db.pool.query("update stage_runs set status='queued', lease_owner=NULL, lease_until=NULL where id=$1", [id]);
    await requestCancel(db.pool, id);
    expect(await reconcile(db.pool, queue, { graceMs: 0 })).toMatchObject({ ...NONE, needsDecision: [id], cancelled: [] });
    expect((await getStage(db.pool, id))?.status).toBe("needs_decision");
    const { rows } = await db.pool.query("select status from spend_intents where stage_run_id=$1", [id]);
    expect(rows).toEqual([{ status: "unknown" }]);
    expect((await queue.liveJobIds()).size).toBe(0);
  });

  it("expired_running_row_with_flag_is_requeued_then_cancelled_in_one_pass", async () => {
    const id = await newStage();
    await claim(id);
    await requestCancel(db.pool, id);
    await expireLease(id);
    expect(await reconcile(db.pool, queue, { graceMs: 0 })).toMatchObject({ ...NONE, requeued: [id], cancelled: [id] });
    expect((await getStage(db.pool, id))?.status).toBe("cancelled");
    // the stale delivery from the requeue is a no-op and spends nothing
    const outcomes: StageOutcome[] = [];
    startRunner(outcomes);
    await waitFor(() => outcomes.length === 1, "stale delivery handled");
    expect(outcomes[0]).toEqual({ kind: "noop" });
    expect(await provider.dbCalls(callKey(id, 0, 0))).toBe(0);
  });

  it("needs_decision_row_with_flag_is_left_untouched", async () => {
    const id = await newStage();
    await claim(id);
    await db.pool.query("update stage_runs set status='needs_decision' where id=$1", [id]);
    await requestCancel(db.pool, id);
    await ageRow(id);
    const before = await getStage(db.pool, id);
    expect(await reconcile(db.pool, queue, { graceMs: 0 })).toMatchObject({ ...NONE, cancelled: [] });
    expect(await getStage(db.pool, id)).toEqual(before);
  });
});
