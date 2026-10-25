import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Queue } from "bullmq";
import { createJobQueue, type JobQueue } from "@/server/queue/job-queue";
import { reconcile } from "@/server/db/reconciler";
import { runStage } from "@/server/db/stage-runner-adapter";
import { claimStage, getStage, insertQueuedStage, markStageNeedsDecision } from "@/server/db/stages";
import { failIntentKnown, getBudget, reserveIntent } from "@/server/db/spend";
import { stageJobId } from "@/server/core/job-id";
import { callKey } from "@/server/core/spend";
import { uuidv7 } from "@/server/core/ids";
import { KnownFailure } from "@/server/core/paid-call";
import type { StageJob, StageOutcome, StageRunnerDeps } from "@/server/core/stage-runner";
import { createFakeProvider, type FakeProvider } from "../support/fake-provider";
import { withTestDb, type TestDb } from "../support/db";
import { ONE_STEP, deferred, waitFor, within } from "./helpers/stage-env";

// Fix round 1: every way a stage could loop forever (requeue -> same deterministic failure -> requeue) must end.

let db: TestDb;
let provider: FakeProvider;
let queue: JobQueue;
let inspect: Queue;
let queueName: string;
let closers: Array<() => Promise<void>> = [];
let queueN = 0;
const warnings: Array<{ event: string; detail: Record<string, unknown> }> = [];

beforeAll(async () => {
  db = await withTestDb();
});
beforeEach(async () => {
  await db.reset();
  provider = createFakeProvider({ pool: db.pool });
  await provider.init();
  await db.pool.query("truncate fake_provider_calls");
  await db.pool.query("insert into budgets (scope, cap_micro_usd) values ('g', 100000000)");
  const suffix = `stuck-${process.pid}-${queueN++}`;
  queueName = `stages-${suffix}`;
  closers = [];
  warnings.length = 0;
  queue = createJobQueue(db.redisUrl, "stages", suffix, { keepFailed: 3 });
  inspect = new Queue(queueName, { connection: { url: db.redisUrl } });
  closers.push(() => queue.close(), () => inspect.close());
});
afterEach(async () => {
  for (const close of closers.reverse()) await close();
});
afterAll(async () => {
  await db?.stop();
});

const H = "h1";
const NONE = { requeued: [], reenqueued: [], needsDecision: [], failed: [] };

function deps(over: Partial<StageRunnerDeps> = {}): StageRunnerDeps {
  return { provider: { call: (key) => provider.call(key) }, ttlMs: 60_000, workerId: "w", stepsFor: () => ONE_STEP, ...over };
}
type Delivery = { outcome?: StageOutcome; error?: string };
function startRunner(d: StageRunnerDeps, seen: Delivery[]): void {
  const w = queue.startWorker(
    async (job) => {
      try {
        seen.push({ outcome: await runStage(db.pool, d, job, { warn: (event, detail) => warnings.push({ event, detail }) }) });
      } catch (err) {
        seen.push({ error: String(err) });
        throw err;
      }
    },
    { onError: () => {} },
  );
  closers.push(() => w.close());
}
async function newStage(): Promise<string> {
  return insertQueuedStage(db.pool, { videoId: uuidv7(), name: "script", inputHash: H });
}
async function expireLease(id: string): Promise<void> {
  await db.pool.query("update stage_runs set lease_until = clock_timestamp() - interval '1 second' where id = $1", [id]);
}
async function ageRow(id: string): Promise<void> {
  await db.pool.query("update stage_runs set updated_at = clock_timestamp() - interval '1 hour' where id = $1", [id]);
}

describe("no stage loops forever", () => {
  it("budget_refused_parks_the_stage_and_reconcile_leaves_it_alone", async () => {
    await db.pool.query("update budgets set cap_micro_usd = 500 where scope = 'g'"); // the step reserves 1000
    const id = await newStage();
    const seen: Delivery[] = [];
    startRunner(deps(), seen);
    await queue.enqueue(id, 0, 0, H);
    await waitFor(() => seen.length === 1, "delivery handled");
    expect(seen[0]?.outcome?.kind).toBe("budget_refused");
    const row = await getStage(db.pool, id);
    expect(row?.status).toBe("needs_decision");
    expect(row?.result).toEqual({ needsDecision: `budget_refused: ${callKey(id, 0, 0)}` });
    await expireLease(id);
    await ageRow(id);
    expect(await reconcile(db.pool, queue, { graceMs: 0 })).toMatchObject(NONE);
    expect((await getStage(db.pool, id))?.status).toBe("needs_decision");
    expect(provider.totalCalls()).toBe(0);
    expect(await getBudget(db.pool, "g")).toMatchObject({ reservedMicroUsd: 0, spentMicroUsd: 0 });
  });

  async function runKnownFailure(reason: string | KnownFailure): Promise<string> {
    const id = await newStage();
    const seen: Delivery[] = [];
    const failure = typeof reason === "string" ? new KnownFailure(reason) : reason;
    startRunner(deps({ provider: { call: async (key) => (await provider.call(key), Promise.reject(failure)) } }), seen);
    await queue.enqueue(id, 0, 0, H);
    await waitFor(() => seen.length === 1, "delivery handled");
    expect(seen[0]?.outcome?.kind).toBe("known_failure");
    expect((await getStage(db.pool, id))?.status).toBe("failed");
    await expireLease(id);
    await ageRow(id);
    expect(await reconcile(db.pool, queue, { graceMs: 0 })).toMatchObject(NONE);
    expect((await getStage(db.pool, id))?.status).toBe("failed");
    expect(await provider.dbCalls(callKey(id, 0, 0))).toBe(1);
    expect(await inspect.getJobCountByTypes("failed")).toBe(0); // the handler returned normally
    return id;
  }

  it("known_failure_fails_the_stage_and_reconcile_leaves_it_alone", async () => {
    const id = await runKnownFailure("provider rejected: bad input");
    expect((await getStage(db.pool, id))?.result).toEqual({ error: "known_failure: provider rejected: bad input" });
    const { rows } = await db.pool.query("select status from spend_intents where stage_run_id = $1", [id]);
    expect(rows).toEqual([{ status: "failed_known" }]);
    expect(await getBudget(db.pool, "g")).toMatchObject({ reservedMicroUsd: 0, spentMicroUsd: 0 });
  });

  // Hostile KnownFailure reasons: the reservation must still be released and the stage failed with a clean reason.
  async function expectReleased(id: string, stageReasonPrefix: string): Promise<void> {
    const { rows } = await db.pool.query("select status, result from spend_intents where stage_run_id = $1", [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed_known");
    expect(await getBudget(db.pool, "g")).toMatchObject({ reservedMicroUsd: 0, spentMicroUsd: 0 });
    const stored = ((await getStage(db.pool, id))?.result as { error: string }).error;
    expect(stored.startsWith(stageReasonPrefix)).toBe(true);
    expect([...stored].length).toBeLessThanOrEqual("known_failure: ".length + 200);
    expect(warnings).toEqual([]);
  }

  it("known_failure_with_nul_reason_releases_the_reservation", async () => {
    const id = await runKnownFailure(`bad\u0000input ${"x".repeat(5000)}`);
    await expectReleased(id, "known_failure: badinput xxx");
    const { rows } = await db.pool.query("select result from spend_intents where stage_run_id = $1", [id]);
    expect((rows[0].result as { error: string }).error).toMatch(/^badinput x+$/);
    expect([...(rows[0].result as { error: string }).error].length).toBe(200);
  });

  it("known_failure_with_lone_surrogate_reason_releases_the_reservation", async () => {
    const id = await runKnownFailure("bad \uD800 input \uDC00 end");
    await expectReleased(id, "known_failure: bad \uFFFD input \uFFFD end");
    const { rows } = await db.pool.query("select result from spend_intents where stage_run_id = $1", [id]);
    expect(rows[0].result).toEqual({ error: "bad \uFFFD input \uFFFD end" });
  });

  it("failIntentKnown_sanitises_a_hostile_reason_itself", async () => {
    // defence in depth: a direct caller (not the wrapper) passing provider text must not make the release fail
    const id = await newStage();
    const c = (await claimStage(db.pool, { id, inputHash: H, workerId: "w", ttlMs: 60_000 }))!;
    for (const [i, reason] of [`a\u0000b ${"y".repeat(5000)}`, "lone \uDBFF here"].entries()) {
      const r = await reserveIntent(db.pool, c, { stepIndex: i, toolCallIndex: 0, reserveMicroUsd: 1000, budgetScopes: ["g"] });
      expect(r.kind).toBe("new");
      expect(await failIntentKnown(db.pool, (r as { intentId: string }).intentId, reason)).toBe(true);
    }
    const { rows } = await db.pool.query("select status, result from spend_intents where stage_run_id = $1 order by step_index", [id]);
    expect(rows.map((r) => r.status)).toEqual(["failed_known", "failed_known"]);
    expect([...(rows[0].result as { error: string }).error].length).toBe(200);
    expect(rows[1].result).toEqual({ error: "lone \uFFFD here" });
    expect(await getBudget(db.pool, "g")).toMatchObject({ reservedMicroUsd: 0 });
  });

  it("known_failure_with_throwing_reason_getter_releases_the_reservation", async () => {
    const err = new KnownFailure("x");
    Object.defineProperty(err, "message", {
      get() {
        throw new Error("hostile getter");
      },
    });
    const id = await runKnownFailure(err);
    await expectReleased(id, "known_failure: unknown");
    const { rows } = await db.pool.query("select result from spend_intents where stage_run_id = $1", [id]);
    expect(rows[0].result).toEqual({ error: "unknown" });
  });

  it("known_failure_with_failed_release_is_parked_not_failed", async () => {
    // The release of the reservation fails (DB blip): the stage must NOT become terminal 'failed' with a held
    // reservation nobody looks at. It stays running; the reconciler parks it for a human.
    const id = await newStage();
    const failure = new KnownFailure("quota exceeded");
    const outcome = await runStage(
      db.pool,
      deps({ provider: { call: async (key) => (await provider.call(key), Promise.reject(failure)) } }),
      { stageRunId: id, inputHash: H },
      {
        warn: (event, detail) => warnings.push({ event, detail }),
        paid: (base) => ({
          ...base,
          failKnown: async () => {
            throw new Error("db down during release");
          },
        }),
      },
    );
    expect(outcome.kind).toBe("known_failure_release_failed");
    expect(warnings).toEqual([
      { event: "paid_call.release_failed", detail: { callKey: callKey(id, 0, 0), intentId: expect.any(String), error: "db down during release" } },
    ]);
    expect((await getStage(db.pool, id))?.status).toBe("running");
    const intent = async () => (await db.pool.query("select status from spend_intents where stage_run_id = $1", [id])).rows;
    expect(await intent()).toEqual([{ status: "pending" }]);

    await expireLease(id);
    expect(await reconcile(db.pool, queue, { graceMs: 0 })).toMatchObject({ ...NONE, needsDecision: [id] });
    expect((await getStage(db.pool, id))?.status).toBe("needs_decision");
    expect(await intent()).toEqual([{ status: "unknown" }]);
    expect(await getBudget(db.pool, "g")).toMatchObject({ reservedMicroUsd: 1000, spentMicroUsd: 0 });
    expect(await provider.dbCalls(callKey(id, 0, 0))).toBe(1);
    expect((await queue.liveJobIds()).size).toBe(0);
  });

  it("failed_stage_job_does_not_accumulate_over_many_laps", async () => {
    const id = await newStage();
    const seen: Delivery[] = [];
    startRunner(deps({ stepsFor: () => { throw new Error("deterministic bug"); } }), seen);
    await queue.enqueue(id, 0, 0, H);
    for (let lap = 1; lap <= 10; lap++) {
      await waitFor(() => seen.length === lap, `lap ${lap} delivered`);
      // this lap's job reaches 'failed'; only the newest 3 failed jobs are kept
      await waitFor(async () => (await inspect.getJobCountByTypes("failed")) === Math.min(lap, 3), `lap ${lap} failed jobs = ${Math.min(lap, 3)}`);
      await waitFor(async () => (await getStage(db.pool, id))?.status === "running", `lap ${lap} claimed`);
      await expireLease(id);
      const r = await reconcile(db.pool, queue, { graceMs: 0, maxAttempts: 100 });
      expect(r.requeued, `lap ${lap}`).toEqual([id]);
    }
    expect(seen.every((s) => s.error?.includes("deterministic bug"))).toBe(true);
    expect(provider.totalCalls()).toBe(0);
  });

  it("deterministic_error_before_any_intent_stops_after_max_attempts", async () => {
    const id = await newStage();
    const seen: Delivery[] = [];
    startRunner(deps({ stepsFor: () => { throw new Error("deterministic bug"); } }), seen);
    await queue.enqueue(id, 0, 0, H);
    const maxAttempts = 3;
    let failed: string[] = [];
    for (let lap = 1; lap <= maxAttempts + 2 && failed.length === 0; lap++) {
      await waitFor(() => seen.length === lap, `lap ${lap} delivered`);
      await waitFor(async () => (await getStage(db.pool, id))?.status === "running", `lap ${lap} claimed`);
      await expireLease(id);
      failed = (await reconcile(db.pool, queue, { graceMs: 0, maxAttempts })).failed;
    }
    expect(failed).toEqual([id]);
    const row = await getStage(db.pool, id);
    expect(row).toMatchObject({ status: "failed", attemptSeq: maxAttempts, result: { reason: "too_many_attempts", attempts: maxAttempts } });
    expect(seen).toHaveLength(maxAttempts + 1); // the original delivery + maxAttempts retries
    expect(await reconcile(db.pool, queue, { graceMs: 0, maxAttempts })).toMatchObject(NONE);
    expect(provider.totalCalls()).toBe(0);
    expect(await provider.dbCalls(callKey(id, 0, 0))).toBe(0);
  });

  it("queued_row_over_max_attempts_is_failed_instead_of_reenqueued", async () => {
    const id = await newStage();
    await db.pool.query("update stage_runs set attempt_seq = 5 where id = $1", [id]);
    await ageRow(id);
    expect(await reconcile(db.pool, queue, { graceMs: 0, maxAttempts: 5 })).toMatchObject({ ...NONE, failed: [id] });
    expect(await getStage(db.pool, id)).toMatchObject({ status: "failed", result: { reason: "too_many_attempts", attempts: 5 } });
    expect((await queue.liveJobIds()).size).toBe(0);
  });

  it("max_attempts_never_touches_needs_decision", async () => {
    // a parked row far over the cap, and a running+expired row over the cap with a pending intent
    const parked = await newStage();
    const c = (await claimStage(db.pool, { id: parked, inputHash: H, workerId: "w", ttlMs: 60_000 }))!;
    await markStageNeedsDecision(db.pool, c, "test");
    await db.pool.query("update stage_runs set attempt_seq = 99 where id = $1", [parked]);
    await expireLease(parked);
    await ageRow(parked);
    const pending = await newStage();
    const c2 = (await claimStage(db.pool, { id: pending, inputHash: H, workerId: "w", ttlMs: 60_000 }))!;
    expect((await reserveIntent(db.pool, c2, { stepIndex: 0, toolCallIndex: 0, reserveMicroUsd: 1000, budgetScopes: ["g"] })).kind).toBe("new");
    await db.pool.query("update stage_runs set attempt_seq = 99 where id = $1", [pending]);
    await expireLease(pending);

    const before = await getStage(db.pool, parked);
    expect(await reconcile(db.pool, queue, { graceMs: 0, maxAttempts: 1 })).toMatchObject({ ...NONE, needsDecision: [pending] });
    expect(await getStage(db.pool, parked)).toEqual(before);
    expect((await getStage(db.pool, pending))?.status).toBe("needs_decision"); // unknown money wins over the cap
    expect(await reconcile(db.pool, queue, { graceMs: 0, maxAttempts: 1 })).toMatchObject(NONE);
  });

  it("stalled_job_goes_to_failed_and_reconciler_requeues_once", async () => {
    // A worker takes the job and hangs WITHOUT renewing its lock (event loop stuck / process frozen) before it
    // claims. With maxStalledCount 0 BullMQ never re-runs it: the stalled job is failed; Postgres still says
    // queued, so the reconciler re-enqueues it under a new attempt id, and the stage runs exactly once.
    const id = await newStage();
    const taken = deferred();
    const release = deferred();
    let hungCalls = 0;
    const hung = queue.startWorker(
      async () => {
        hungCalls++;
        taken.resolve();
        await release.promise;
      },
      { onError: () => {}, bullmq: { skipLockRenewal: true, lockDuration: 300, stalledInterval: 200 } },
    );
    closers.push(async () => {
      release.resolve();
      await hung.close();
    });
    await queue.enqueue(id, 0, 0, H);
    await within(taken.promise, "hung worker took the job");

    const seen: Delivery[] = [];
    const w = queue.startWorker(
      async (job: StageJob) => {
        seen.push({ outcome: await runStage(db.pool, deps(), job) });
      },
      { onError: () => {}, bullmq: { stalledInterval: 200 } },
    );
    closers.push(() => w.close());
    await waitFor(async () => (await inspect.getJobState(stageJobId(id, 0, 0))) === "failed", "stalled job failed", 20_000);
    expect(seen).toHaveLength(0); // the stalled job was NOT re-delivered to a handler
    expect(hungCalls).toBe(1);
    expect((await getStage(db.pool, id))?.status).toBe("queued");

    expect(await reconcile(db.pool, queue, { graceMs: 0 })).toMatchObject({ ...NONE, reenqueued: [id] });
    await waitFor(async () => (await getStage(db.pool, id))?.status === "succeeded", "new attempt ran");
    expect(seen.map((s) => s.outcome?.kind)).toEqual(["committed"]);
    expect(await provider.dbCalls(callKey(id, 0, 0))).toBe(1);
    expect(await reconcile(db.pool, queue, { graceMs: 0 })).toMatchObject(NONE);
  });
});
