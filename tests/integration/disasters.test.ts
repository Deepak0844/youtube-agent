import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { createJobQueue, type JobQueue } from "@/server/queue/job-queue";
import { reconcile } from "@/server/db/reconciler";
import { runStage } from "@/server/db/stage-runner-adapter";
import { claimStage, commitStage, getStage, insertQueuedStage, markStageNeedsDecision } from "@/server/db/stages";
import { getBudget, reserveIntent } from "@/server/db/spend";
import { stageJobId } from "@/server/core/job-id";
import { callKey } from "@/server/core/spend";
import { uuidv7 } from "@/server/core/ids";
import type { StageOutcome, StageRunnerDeps } from "@/server/core/stage-runner";
import { createFakeProvider, type FakeProvider } from "../support/fake-provider";
import { withTestDb, type TestDb } from "../support/db";
import { ONE_STEP, deferred, killAllChildren, spawnChildWorker, waitFor, within } from "./helpers/stage-env";

let db: TestDb;
let provider: FakeProvider;
let queue: JobQueue;
let closers: Array<() => Promise<void>> = [];
let queueN = 0;
const workerErrors: Error[] = [];

beforeAll(async () => {
  db = await withTestDb();
});
beforeEach(async () => {
  await db.reset();
  provider = createFakeProvider({ pool: db.pool });
  await provider.init();
  await db.pool.query("truncate fake_provider_calls");
  await db.pool.query("insert into budgets (scope, cap_micro_usd) values ('g', 100000000)");
  queue = createJobQueue(db.redisUrl, "stages", `disasters-${process.pid}-${queueN++}`);
  closers = [() => queue.close()];
  workerErrors.length = 0;
});
afterEach(async () => {
  await killAllChildren();
  for (const close of closers.reverse()) await close();
});
afterAll(async () => {
  await db?.stop();
});

const H = "h1";
const KEY = (id: string) => callKey(id, 0, 0);

function deps(workerId: string, over: Partial<StageRunnerDeps> = {}): StageRunnerDeps {
  return { provider: { call: (key) => provider.call(key) }, ttlMs: 60_000, workerId, stepsFor: () => ONE_STEP, ...over };
}

// A real BullMQ worker running the real worker body; records each delivery's outcome.
function startRunner(d: StageRunnerDeps, outcomes: StageOutcome[], concurrency = 1): void {
  const w = queue.startWorker(
    async (job) => {
      outcomes.push(await runStage(db.pool, d, job));
    },
    { concurrency, onError: (e) => workerErrors.push(e) },
  );
  closers.push(() => w.close());
}

async function newStage(inputHash = H): Promise<string> {
  return insertQueuedStage(db.pool, { videoId: uuidv7(), name: "script", inputHash });
}
async function expireLease(id: string): Promise<void> {
  await db.pool.query("update stage_runs set lease_until = clock_timestamp() - interval '1 second' where id = $1", [id]);
}
async function status(id: string): Promise<string | undefined> {
  return (await getStage(db.pool, id))?.status;
}
async function intentStatus(id: string): Promise<string | undefined> {
  const { rows } = await db.pool.query("select status from spend_intents where call_key = $1", [KEY(id)]);
  return rows[0]?.status;
}
async function flushRedis(): Promise<void> {
  const r = new Redis(db.redisUrl, { maxRetriesPerRequest: 1 });
  try {
    await r.flushall();
  } finally {
    r.disconnect();
  }
}
function childEnv(id: string, stopAfter: string): Record<string, string> {
  return {
    DATABASE_URL: db.pool.options.connectionString!,
    STAGE_ID: id,
    INPUT_HASH: H,
    WORKER_ID: "child",
    STOP_AFTER: stopAfter,
  };
}

describe("disasters", () => {
  it("duplicate_delivery_runs_the_stage_once", async () => {
    // 20 deliveries of the same stage (distinct attempt ids, plus one exact duplicate BullMQ swallows) to 3 real workers.
    const id = await newStage();
    const outcomes: StageOutcome[] = [];
    for (let a = 0; a < 20; a++) await queue.enqueue(id, 0, a, H);
    await queue.enqueue(id, 0, 0, H); // same id again: BullMQ dedupes
    for (const w of ["w1", "w2", "w3"]) startRunner(deps(w), outcomes, 5);
    await waitFor(() => outcomes.length === 20, "20 deliveries handled");
    expect(outcomes.filter((o) => o.kind === "committed")).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === "noop")).toHaveLength(19);
    expect(await status(id)).toBe("succeeded");
    expect(await provider.dbCalls(KEY(id))).toBe(1);

    // and the handler called directly 20 times at once
    const id2 = await newStage();
    const direct = await Promise.all(Array.from({ length: 20 }, (_, i) => runStage(db.pool, deps(`d${i}`), { stageRunId: id2, inputHash: H })));
    expect(direct.filter((o) => o.kind === "committed")).toHaveLength(1);
    expect(direct.filter((o) => o.kind === "noop")).toHaveLength(19);
    expect(await provider.dbCalls(KEY(id2))).toBe(1);
    expect(workerErrors).toEqual([]);
  });

  it("stalled_worker_is_requeued_and_no_paid_call_repeats", async () => {
    const id = await newStage();
    const child = spawnChildWorker(childEnv(id, "SETTLED"));
    await child.waitMarker("SETTLED");
    await child.kill9();
    expect(await provider.dbCalls(KEY(id))).toBe(1);
    expect(await intentStatus(id)).toBe("done");

    // lease still live on the DB clock: the reconciler does nothing
    expect(await reconcile(db.pool, queue, { graceMs: 0 })).toMatchObject({ requeued: [], reenqueued: [], needsDecision: [] });
    expect(await status(id)).toBe("running");

    await expireLease(id);
    const r = await reconcile(db.pool, queue);
    expect(r).toMatchObject({ requeued: [id], reenqueued: [], needsDecision: [] });
    const row = await getStage(db.pool, id);
    expect(row).toMatchObject({ status: "queued", fence: 1, attemptSeq: 1, leaseOwner: null, leaseUntil: null });
    expect(row?.attemptJobId).toBe(stageJobId(id, 1, 1));
    expect((await queue.liveJobIds()).has(stageJobId(id, 1, 1))).toBe(true);

    const outcomes: StageOutcome[] = [];
    startRunner(deps("w2"), outcomes);
    await waitFor(async () => (await status(id)) === "succeeded", "stage succeeded");
    expect(outcomes.map((o) => o.kind)).toEqual(["committed"]);
    expect(await provider.dbCalls(KEY(id))).toBe(1); // the settled call was reused
    expect(provider.totalCalls()).toBe(0);
    expect((await getStage(db.pool, id))?.result).toEqual({ steps: [{ text: "ok" }] });
  });

  it("stalled_worker_with_pending_intent_goes_to_needs_decision", async () => {
    // killed after the intent insert (provider not yet called) and after the provider returned (settle not run)
    for (const [marker, callsAtKill] of [["INTENT_RESERVED", 0], ["PROVIDER_RETURNED", 1]] as const) {
      const id = await newStage();
      const child = spawnChildWorker(childEnv(id, marker));
      await child.waitMarker(marker);
      await child.kill9();
      expect(await provider.dbCalls(KEY(id)), marker).toBe(callsAtKill);
      expect(await intentStatus(id), marker).toBe("pending");

      await expireLease(id);
      const r = await reconcile(db.pool, queue, { graceMs: 0 });
      expect(r, marker).toMatchObject({ requeued: [], reenqueued: [], needsDecision: [id] });
      expect(await status(id), marker).toBe("needs_decision");
      expect(await intentStatus(id), marker).toBe("unknown");
      expect((await queue.liveJobIds()).size, marker).toBe(0);
      expect(await reconcile(db.pool, queue, { graceMs: 0 }), marker).toMatchObject({ requeued: [], reenqueued: [], needsDecision: [] });

      // a stray delivery of an old job finds nothing to claim
      expect((await runStage(db.pool, deps("late"), { stageRunId: id, inputHash: H })).kind, marker).toBe("noop");
      expect(await provider.dbCalls(KEY(id)), marker).toBe(callsAtKill);
    }
    const b = await getBudget(db.pool, "g");
    expect(b?.reservedMicroUsd).toBe(2000); // both reservations held until a human decides
    expect(b?.spentMicroUsd).toBe(0);
  });

  it("lease_expiring_during_a_paid_call_does_not_cause_a_second_call", async () => {
    const id = await newStage();
    const inFlight = deferred();
    const release = deferred();
    const outcomes: StageOutcome[] = [];
    startRunner(
      deps("w1", {
        ttlMs: 300,
        provider: {
          call: async (key) => {
            const out = await provider.call(key);
            inFlight.resolve();
            await release.promise;
            return { ...out, actualMicroUsd: 42 };
          },
        },
      }),
      outcomes,
    );
    await queue.enqueue(id, 0, 0, H);
    await within(inFlight.promise, "paid call in flight");
    await expireLease(id); // the heartbeat cannot revive an expired lease
    const r = await reconcile(db.pool, queue, { graceMs: 0 });
    expect(r).toMatchObject({ requeued: [], reenqueued: [], needsDecision: [id] });
    release.resolve();
    await waitFor(() => outcomes.length === 1, "first attempt finished");
    expect(outcomes[0]?.kind).toBe("commit_rejected"); // money recorded, stale commit refused by the fence/status
    expect(await status(id)).toBe("needs_decision");
    expect(await intentStatus(id)).toBe("done"); // late settle from unknown still lands
    expect(await getBudget(db.pool, "g")).toMatchObject({ reservedMicroUsd: 0, spentMicroUsd: 42 });
    expect(await reconcile(db.pool, queue, { graceMs: 0 })).toMatchObject({ requeued: [], reenqueued: [], needsDecision: [] });
    expect(await provider.dbCalls(KEY(id))).toBe(1);
  });

  it("redis_wipe_with_queued_rows_reenqueues_and_runs_each_once", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const id = await newStage();
      await queue.enqueue(id, 0, 0, H);
      ids.push(id);
    }
    expect((await queue.liveJobIds()).size).toBe(10);
    await flushRedis();
    expect((await queue.liveJobIds()).size).toBe(0);

    const r = await reconcile(db.pool, queue, { graceMs: 0 });
    expect([...r.reenqueued].sort()).toEqual([...ids].sort());
    expect(r).toMatchObject({ requeued: [], needsDecision: [] });
    const live = await queue.liveJobIds();
    for (const id of ids) {
      const row = await getStage(db.pool, id);
      expect(row?.attemptSeq).toBe(1);
      expect(row?.attemptJobId).toBe(stageJobId(id, 0, 1));
      expect(live.has(stageJobId(id, 0, 1))).toBe(true);
      expect(live.has(stageJobId(id, 0, 0))).toBe(false);
    }

    const outcomes: StageOutcome[] = [];
    startRunner(deps("w"), outcomes, 4);
    await waitFor(() => outcomes.length === 10, "10 stages ran");
    for (const id of ids) {
      expect(await status(id)).toBe("succeeded");
      expect(await provider.dbCalls(KEY(id))).toBe(1);
    }
    expect(outcomes.every((o) => o.kind === "committed")).toBe(true);
    expect(await reconcile(db.pool, queue, { graceMs: 0 })).toMatchObject({ requeued: [], reenqueued: [], needsDecision: [] });
  });

  it("redis_wipe_while_a_job_is_running_does_not_start_a_second_run", async () => {
    const id = await newStage();
    const inFlight = deferred();
    const release = deferred();
    const outcomes: StageOutcome[] = [];
    const d = deps("w1", {
      provider: {
        call: async (key) => {
          const out = await provider.call(key);
          inFlight.resolve();
          await release.promise;
          return out;
        },
      },
    });
    startRunner(d, outcomes);
    await queue.enqueue(id, 0, 0, H);
    await within(inFlight.promise, "paid call in flight");
    startRunner(deps("w2"), outcomes); // a second worker that would happily take a second run
    await flushRedis();
    const before = await getStage(db.pool, id);
    const r = await reconcile(db.pool, queue, { graceMs: 0 });
    expect(r).toMatchObject({ requeued: [], reenqueued: [], needsDecision: [] });
    const after = await getStage(db.pool, id);
    expect({ ...after, leaseUntil: null, updatedAt: null }).toEqual({ ...before, leaseUntil: null, updatedAt: null });
    expect(after?.status).toBe("running");
    expect((await queue.liveJobIds()).size).toBe(0);

    release.resolve();
    await waitFor(async () => (await status(id)) === "succeeded", "stage succeeded");
    await waitFor(() => outcomes.length === 1, "first run reported");
    expect(outcomes.map((o) => o.kind)).toEqual(["committed"]);
    expect(await provider.dbCalls(KEY(id))).toBe(1);
  });

  it("job_id_is_unique_per_attempt", async () => {
    const id = await newStage();
    const a = await queue.enqueue(id, 1, 0, H);
    const b = await queue.enqueue(id, 2, 0, H);
    const c = await queue.enqueue(id, 2, 1, H);
    expect([a, b, c]).toEqual([stageJobId(id, 1, 0), stageJobId(id, 2, 0), stageJobId(id, 2, 1)]);
    expect(await queue.liveJobIds()).toEqual(new Set([a, b, c]));
    await queue.enqueue(id, 2, 1, H); // the same attempt again is a no-op in BullMQ
    expect((await queue.liveJobIds()).size).toBe(3);
  });

  it("reconciler_never_requeues_needs_decision", async () => {
    // one parked with an unknown intent, one parked with no intent at all; both with expired leases and old updated_at
    const withIntent = await newStage();
    const bare = await newStage();
    for (const id of [withIntent, bare]) {
      const c = (await claimStage(db.pool, { id, inputHash: H, workerId: "w", ttlMs: 60_000 }))!;
      if (id === withIntent) {
        expect((await reserveIntent(db.pool, c, { stepIndex: 0, toolCallIndex: 0, reserveMicroUsd: 1000, budgetScopes: ["g"] })).kind).toBe("new");
        await db.pool.query("update spend_intents set status='unknown' where stage_run_id=$1", [id]);
      }
      expect(await markStageNeedsDecision(db.pool, c, "test")).toBe(true);
      await db.pool.query(
        "update stage_runs set lease_until = clock_timestamp() - interval '1 hour', updated_at = clock_timestamp() - interval '1 hour' where id=$1",
        [id],
      );
    }
    const before = await Promise.all([withIntent, bare].map((id) => getStage(db.pool, id)));
    const intentsBefore = (await db.pool.query("select * from spend_intents order by id")).rows;
    for (let i = 0; i < 3; i++) {
      expect(await reconcile(db.pool, queue, { graceMs: 0 })).toMatchObject({ requeued: [], reenqueued: [], needsDecision: [] });
    }
    expect(await Promise.all([withIntent, bare].map((id) => getStage(db.pool, id)))).toEqual(before);
    expect((await db.pool.query("select * from spend_intents order by id")).rows).toEqual(intentsBefore);
    expect((await queue.liveJobIds()).size).toBe(0);
  });

  it("handler_noop_when_claim_returns_null", async () => {
    const succeeded = await newStage();
    const c = (await claimStage(db.pool, { id: succeeded, inputHash: H, workerId: "x", ttlMs: 60_000 }))!;
    await commitStage(db.pool, c, { done: true });
    const running = await newStage();
    await claimStage(db.pool, { id: running, inputHash: H, workerId: "other", ttlMs: 60_000 });
    const parked = await newStage();
    const p = (await claimStage(db.pool, { id: parked, inputHash: H, workerId: "x", ttlMs: 60_000 }))!;
    await markStageNeedsDecision(db.pool, p, "test");

    for (const id of [succeeded, running, parked, uuidv7()]) {
      const before = await getStage(db.pool, id);
      expect((await runStage(db.pool, deps("w"), { stageRunId: id, inputHash: H })).kind).toBe("noop");
      expect(await getStage(db.pool, id)).toEqual(before);
    }
    // the same through a real delivery
    const outcomes: StageOutcome[] = [];
    startRunner(deps("w"), outcomes);
    await queue.enqueue(running, 0, 7, H);
    await waitFor(() => outcomes.length === 1, "delivery handled");
    expect(outcomes[0]?.kind).toBe("noop");
    expect(provider.totalCalls()).toBe(0);
    expect(workerErrors).toEqual([]);
  });

  it("job_with_stale_input_hash_is_a_noop", async () => {
    const id = await newStage("h-old");
    await queue.enqueue(id, 0, 0, "h-old");
    await db.pool.query("update stage_runs set input_hash = 'h-new', updated_at = clock_timestamp() where id = $1", [id]);
    const outcomes: StageOutcome[] = [];
    startRunner(deps("w"), outcomes);
    await waitFor(() => outcomes.length === 1, "stale job delivered");
    expect(outcomes[0]?.kind).toBe("noop");
    expect(await getStage(db.pool, id)).toMatchObject({ status: "queued", fence: 0, inputHash: "h-new" });
    expect(await provider.dbCalls(KEY(id))).toBe(0);

    // the reconciler re-enqueues with the row's CURRENT hash, and that attempt runs
    expect((await reconcile(db.pool, queue, { graceMs: 0 })).reenqueued).toEqual([id]);
    await waitFor(async () => (await status(id)) === "succeeded", "current-hash attempt ran");
    expect(await provider.dbCalls(KEY(id))).toBe(1);
  });
});
