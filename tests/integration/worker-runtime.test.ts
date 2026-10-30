import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NotProcessedError } from "@/server/core/error-class";
import { advanceVideo } from "@/server/db/pipeline";
import { createVideoRow } from "@/server/db/videos";
import { createPool } from "@/server/db/pool";
import { insertQueuedStage, getStage } from "@/server/db/stages";
import { setSetting } from "@/server/db/settings";
import { reconcile } from "@/server/db/reconciler";
import { createJobQueue, type StageQueue } from "@/server/queue/job-queue";
import { uuidv7 } from "@/server/core/ids";
import { startWorker } from "@/worker";
import type { WorkerOptions } from "@/worker/runtime";
import { withTestDb, type TestDb } from "../support/db";
import { deferred, waitFor } from "./helpers/stage-env";

let db: TestDb; let queue: StageQueue; let seq = 0;
let workers: Array<ReturnType<typeof startWorker>> = [];
const children: ChildProcess[] = [];
beforeAll(async () => { db = await withTestDb(); });
beforeEach(async () => {
  await db.reset(); queue = createJobQueue(db.redisUrl, "stages", `runtime-${process.pid}-${seq++}`); workers = [];
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
  }
  await Promise.all(workers.map((w) => w.stop())); await queue.close();
});
afterAll(async () => { await db?.stop(); });
const stage = (name = "draft") => insertQueuedStage(db.pool, { videoId: uuidv7(), name, inputHash: "h1" });
function boot(opts: Partial<WorkerOptions> = {}) {
  const worker = startWorker({
    pool: createPool(db.pool.options.connectionString!), redisUrl: db.redisUrl, log: vi.fn(),
    ...opts, hooks: { connectQueue: async () => queue, ...opts.hooks },
  });
  workers.push(worker); return worker;
}

describe("worker runtime with Postgres and Redis", () => {
  it("job_for_unknown_stage_name_fails_cleanly", async () => {
    const worker = boot({ handlers: { render: async () => ({}) } }); await worker.ready;
    const id = await stage("unrecognised"); await queue.enqueue(id, 0, 0, "h1");
    await waitFor(async () => (await getStage(db.pool, id))?.status === "failed", "unknown stage failed");
    expect((await getStage(db.pool, id))?.result).toMatchObject({ error: expect.stringContaining("unknown stage") });
  });

  it("missing_stage_handler_is_terminal_without_provider_fallback", async () => {
    const worker = boot({ handlers: { render: async () => ({}) } }); await worker.ready;
    const id = await stage(); await queue.enqueue(id, 0, 0, "h1");
    await waitFor(async () => (await getStage(db.pool, id))?.status === "failed", "missing handler failed");
    expect((await getStage(db.pool, id))?.result).toEqual({ error: "known_failure: missing stage handler: draft" });
    expect((await db.pool.query("select * from spend_intents")).rows).toEqual([]);
  });

  it("failed_stage_writes_one_in_app_notification_and_a_throwing_notifier_does_not_break_the_job", async () => {
    const worker = boot({ handlers: { render: async () => ({}) } }); await worker.ready;
    const id = await stage(); await queue.enqueue(id, 0, 0, "h1");
    await waitFor(async () => (await db.pool.query("select 1 from notifications")).rowCount === 1, "failure notified");
    const rows = (await db.pool.query("select event, to_state, video_id, transition_id from notifications")).rows;
    expect(rows).toEqual([{ event: "video_failed", to_state: "failed", video_id: (await getStage(db.pool, id))!.videoId, transition_id: expect.stringMatching(new RegExp(`^${id}\\.\\d+$`)) }]);
    // A notifier that throws must not change the stage outcome.
    const id2 = await stage();
    const bad = boot({ handlers: { render: async () => ({}) }, hooks: { notify: async () => { throw new Error("boom"); } } }); await bad.ready;
    await queue.enqueue(id2, 0, 0, "h1");
    await waitFor(async () => (await getStage(db.pool, id2))?.status === "failed", "still failed");
  });

  it("a_confirmed_provider_rejection_schedules_a_delayed_retry_row_and_stays_quiet_until_retries_run_out", async () => {
    const v = await createVideoRow(db.pool, { format: "short", kind: "scene_kit", language: "en", topic: "Why the sky is blue" });
    await advanceVideo(db.pool, queue, v.id);
    const worker = boot({ handlers: { draft: async () => { throw new NotProcessedError("provider said 429", { status: 429 }); } } }); await worker.ready;
    const rows = async () => (await db.pool.query("select id, status, retry_of, not_before, input_hash, result from stage_runs where video_id = $1 order by created_at, id", [v.id])).rows;
    await waitFor(async () => (await rows()).length === 2, "retry row created");
    const [failed, retry] = await rows();
    expect(failed).toMatchObject({ status: "failed", result: { class: "transient" } });
    expect(retry).toMatchObject({ status: "queued", retry_of: failed.id, input_hash: failed.input_hash });
    expect(retry.not_before.getTime()).toBeGreaterThan(Date.now() + 20_000); // 30 s back-off on the database clock
    // not a "video failed" notice while a retry is coming
    expect((await db.pool.query("select 1 from notifications where event = 'video_failed'")).rowCount).toBe(0);
    // and the worker does not run it early
    await new Promise((r) => setTimeout(r, 300));
    expect((await rows()).map((r) => r.status)).toEqual(["failed", "queued"]);
  });

  it("a_retry_held_by_the_breaker_is_not_reported_as_a_failed_video", async () => {
    await setSetting(db.pool, "breaker.threshold", 1, { actor: "session" });
    const v = await createVideoRow(db.pool, { format: "short", kind: "scene_kit", language: "en", topic: "Why the sky is blue" });
    await advanceVideo(db.pool, queue, v.id);
    const worker = boot({ handlers: { draft: async () => { throw new NotProcessedError("slow down", { status: 429 }); } } }); await worker.ready;
    await waitFor(async () => (await db.pool.query("select 1 from notifications where event = 'spend_cap_hit'")).rowCount === 1, "breaker notified");
    await new Promise((r) => setTimeout(r, 300));
    expect((await db.pool.query("select 1 from notifications where event = 'video_failed'")).rowCount).toBe(0);
    expect((await db.pool.query("select count(*)::int n from stage_runs where video_id = $1", [v.id])).rows[0].n).toBe(1); // held: no retry row yet
  });

  it("the_retry_sweep_reports_give_ups_and_uses_the_same_decision_readers_as_advance", async () => {
    const a = await stage();
    const readers = { approvedGates: async () => new Set<never>(), feedback: async () => null };
    const advanceAll = vi.fn<(p: unknown, q: unknown, r: unknown) => Promise<void>>(async () => {});
    const sweepRetries = vi.fn<(p: unknown, q: unknown, r: unknown) => Promise<{ scheduled: string[]; held: string[]; gaveUp: string[] }>>(async () => ({ scheduled: [], held: [], gaveUp: [a] }));
    const worker = boot({ readers, intervalMs: 20, handlers: { render: async () => ({}) }, hooks: { advanceAll, sweepRetries } }); await worker.ready;
    await waitFor(async () => (await db.pool.query("select 1 from notifications where event = 'video_failed'")).rowCount === 1, "give-up notified");
    await new Promise((r) => setTimeout(r, 100));
    expect((await db.pool.query("select 1 from notifications where event = 'video_failed'")).rowCount).toBe(1); // once
    expect(advanceAll.mock.calls[0]![2]).toBe(readers);
    expect(sweepRetries.mock.calls[0]![2]).toBe(readers);
  });

  it("an_opening_breaker_tells_the_owner_once", async () => {
    await setSetting(db.pool, "breaker.threshold", 1, { actor: "session" });
    const v = await createVideoRow(db.pool, { format: "short", kind: "scene_kit", language: "en", topic: "Why the sky is blue" });
    await advanceVideo(db.pool, queue, v.id);
    const worker = boot({ handlers: { draft: async () => { throw new NotProcessedError("bad request", { status: 400 }); } } }); await worker.ready;
    await waitFor(async () => (await db.pool.query("select 1 from notifications where event = 'spend_cap_hit'")).rowCount === 1, "breaker notified");
    await waitFor(async () => (await db.pool.query("select 1 from notifications where event = 'video_failed'")).rowCount === 1, "failure notified");
    expect((await db.pool.query("select 1 from notifications where event = 'spend_cap_hit'")).rowCount).toBe(1);
    expect((await advanceVideo(db.pool, queue, (await createVideoRow(db.pool, { format: "short", kind: "scene_kit", language: "en", topic: "Another" })).id)).held).toMatchObject({ stage: "draft" });
  });

  it("worker_without_handlers_leaves_rows_queued_and_does_not_advance", async () => {
    const advanceAll = vi.fn<(p: unknown, q: unknown, r: unknown) => Promise<void>>(async () => {}); const log = vi.fn();
    const worker = boot({ log, intervalMs: 20, hooks: { advanceAll } }); await worker.ready;
    const id = await stage(); await queue.enqueue(id, 0, 0, "h1");
    await waitFor(async () => log.mock.calls.some((c) => c[0] === "reconcile ok"), "loop ran");
    await new Promise((r) => setTimeout(r, 200));
    expect((await getStage(db.pool, id))?.status).toBe("queued");
    expect(advanceAll).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no stage handlers registered"));
  });

  it("reconciler_parked_and_failed_stages_notify_the_owner_once", async () => {
    const a = await stage(); const b = await stage();
    const reconcileFn = vi.fn(async () => ({ requeued: [], reenqueued: [], needsDecision: [a], failed: [b], cancelled: [], enqueueFailed: [] }));
    // The stub repeats the same ids every tick (the real reconciler reports each transition once), so keep breaker counting out of this notice test.
    const worker = boot({ intervalMs: 20, hooks: { reconcile: reconcileFn, afterReconcile: async () => [] } }); await worker.ready;
    await waitFor(async () => (await db.pool.query("select 1 from notifications")).rowCount === 2, "both notified");
    await new Promise((r) => setTimeout(r, 100)); // further ticks must not add rows
    const rows = (await db.pool.query("select event, to_state from notifications order by event")).rows;
    expect(rows).toEqual([{ event: "needs_decision", to_state: "needs_decision" }, { event: "video_failed", to_state: "failed" }]);
  });

  it("lost_attempt_folders_are_swept_once_per_interval_not_every_tick", async () => {
    const sweepLostAttempts = vi.fn(async () => 0);
    const worker = boot({ intervalMs: 20, hooks: { sweepLostAttempts } }); await worker.ready;
    await waitFor(async () => sweepLostAttempts.mock.calls.length >= 1, "swept");
    await new Promise((r) => setTimeout(r, 150)); // many more ticks
    expect(sweepLostAttempts).toHaveBeenCalledTimes(1);
  });

  it("clean_stop_waits_for_the_in_flight_job_to_commit", async () => {
    const started = deferred();
    const worker = boot({ handlers: { draft: async () => { started.resolve(); await new Promise((r) => setTimeout(r, 400)); return { ok: true }; } } }); await worker.ready;
    const id = await stage(); await queue.enqueue(id, 0, 0, "h1");
    await started.promise; await worker.stop();
    expect((await getStage(db.pool, id))?.status).toBe("succeeded");
  });

  it("worker_starts_stops_and_logs_without_redis_when_redis_is_down", async () => {
    const log = vi.fn();
    const worker = startWorker({ pool: createPool(db.pool.options.connectionString!), redisUrl: "redis://127.0.0.1:1", log, retryMs: 20 });
    workers.push(worker); await worker.ready;
    await waitFor(() => log.mock.calls.filter(([line]) => line === "waiting for Redis").length >= 2, "Redis connection retried");
    await worker.stop(); expect(log).toHaveBeenLastCalledWith("worker stopped");
  });

  it("render_semaphore_serialises_render_stages", async () => {
    const hold = deferred(); let active = 0; let peak = 0;
    const render = vi.fn(async () => { peak = Math.max(peak, ++active); await hold.promise; active--; return {}; });
    const worker = boot({ handlers: { render } }); await worker.ready;
    const ids = await Promise.all([stage("render"), stage("render")]);
    await Promise.all(ids.map((id) => queue.enqueue(id, 0, 0, "h1")));
    await waitFor(() => render.mock.calls.length === 1, "first render started");
    await waitFor(async () => (await queue.liveJobIds()).size === 1, "second render deferred by shared admission");
    expect(render).toHaveBeenCalledTimes(1); hold.resolve();
    await waitFor(async () => (await Promise.all(ids.map((id) => getStage(db.pool, id)))).some((r) => r?.status === "succeeded"), "first render completed");
    await reconcile(db.pool, queue, { graceMs: 0 });
    await waitFor(async () => (await Promise.all(ids.map((id) => getStage(db.pool, id)))).every((r) => r?.status === "succeeded"), "both renders completed");
    expect(render).toHaveBeenCalledTimes(2); expect(peak).toBe(1);
  });

  it("shutdown_with_pending_paid_intent_is_parked_on_next_boot_without_retry", async () => {
    await db.pool.query("insert into budgets (scope, cap_micro_usd) values ('g', 100000)");
    const provider = vi.fn(async () => new Promise<never>(() => {}));
    const first = boot({ handlers: { draft: async (ctx) => ctx.paid({ reserveMicroUsd: 1000, budgetScopes: ["g"], kind: "paid" }, provider) } });
    await first.ready; const id = await stage(); await queue.enqueue(id, 0, 0, "h1");
    await waitFor(() => provider.mock.calls.length === 1, "paid call started"); await first.stop();
    expect((await getStage(db.pool, id))?.status).toBe("running");
    await db.pool.query("update stage_runs set lease_until = clock_timestamp() - interval '1 second' where id = $1", [id]);
    queue = createJobQueue(db.redisUrl, "stages", `paid-reboot-${process.pid}-${seq++}`);
    const draft = vi.fn(async () => ({})); const second = boot({ handlers: { draft } }); await second.ready;
    await waitFor(async () => (await getStage(db.pool, id))?.status === "needs_decision", "unknown paid outcome parked");
    expect(draft).not.toHaveBeenCalled(); expect(provider).toHaveBeenCalledTimes(1);
    expect((await db.pool.query("select status from spend_intents where stage_run_id = $1", [id])).rows).toEqual([{ status: "unknown" }]);
    expect((await db.pool.query("select reserved_micro_usd from budgets where scope = 'g'")).rows[0].reserved_micro_usd).toBe("1000");
  });

  it("concurrency_limit_is_respected_across_two_jobs", async () => {
    await setSetting(db.pool, "jobs.concurrent_jobs", 1, { actor: "session" });
    const hold = deferred(); let active = 0; let peak = 0;
    const draft = vi.fn(async () => { peak = Math.max(peak, ++active); await hold.promise; active--; return {}; });
    const a = boot({ handlers: { draft }, workerId: "a" });
    const b = boot({ handlers: { draft }, workerId: "b", hooks: { connectQueue: async () => createJobQueue(db.redisUrl, "stages", queue.name.slice(7)) } });
    await Promise.all([a.ready, b.ready]);
    const ids = await Promise.all([stage(), stage()]);
    await Promise.all(ids.map((id) => queue.enqueue(id, 0, 0, "h1")));
    await waitFor(() => draft.mock.calls.length === 1, "one stage claimed");
    await waitFor(async () => (await queue.liveJobIds()).size === 1, "refused delivery completed");
    const rows = await Promise.all(ids.map((id) => getStage(db.pool, id)));
    expect(rows.map((r) => r!.status).sort()).toEqual(["queued", "running"]);
    hold.resolve();
    await waitFor(async () => (await Promise.all(ids.map((id) => getStage(db.pool, id)))).some((r) => r?.status === "succeeded"), "first completed");
    await reconcile(db.pool, queue, { graceMs: 0 });
    await waitFor(async () => (await Promise.all(ids.map((id) => getStage(db.pool, id)))).every((r) => r?.status === "succeeded"), "refused stage recovered");
    expect(peak).toBe(1);
  });

  it("saturation_over_more_ticks_than_retry_cap_never_fails_unstarted_work", async () => {
    await setSetting(db.pool, "jobs.concurrent_jobs", 1, { actor: "session" });
    await setSetting(db.pool, "engine.retry_attempts", 2, { actor: "session" });
    const hold = deferred(); const draft = vi.fn(async () => { await hold.promise; return {}; });
    const a = boot({ handlers: { draft }, workerId: "saturation-a", intervalMs: 20 });
    const b = boot({ handlers: { draft }, workerId: "saturation-b", intervalMs: 20,
      hooks: { connectQueue: async () => createJobQueue(db.redisUrl, "stages", queue.name.slice(7)) } });
    await Promise.all([a.ready, b.ready]);
    const first = await stage(); await queue.enqueue(first, 0, 0, "h1");
    await waitFor(() => draft.mock.calls.length === 1, "first occupies capacity");
    const waiting = await stage(); await queue.enqueue(waiting, 0, 0, "h1");
    for (let tick = 0; tick < 6; tick++) {
      await waitFor(async () => (await queue.liveJobIds()).size === 1, "refused delivery finished");
      const before = (await getStage(db.pool, waiting))!.attemptSeq;
      await db.pool.query("update stage_runs set updated_at = clock_timestamp() - interval '1 minute' where id = $1", [waiting]);
      await waitFor(async () => { const row = await getStage(db.pool, waiting); return row!.attemptSeq > before || row!.status === "failed"; }, "maintenance tick delivered again");
      expect(await getStage(db.pool, waiting)).toMatchObject({ status: "queued", fence: 0 });
    }
    hold.resolve();
    await waitFor(async () => (await getStage(db.pool, first))?.status === "succeeded", "capacity released");
    await waitFor(async () => (await queue.liveJobIds()).size === 0, "previous delivery settled");
    await db.pool.query("update stage_runs set updated_at = clock_timestamp() - interval '1 minute' where id = $1", [waiting]);
    await waitFor(async () => (await getStage(db.pool, waiting))?.status === "succeeded", "never-started stage eventually ran");
    expect(draft).toHaveBeenCalledTimes(2);
  });

  it("claim_based_runtime_budget_still_caps_started_execution_failures", async () => {
    await setSetting(db.pool, "engine.retry_attempts", 2, { actor: "session" });
    const draft = vi.fn(async () => { throw new Error("execution failed before any paid intent"); });
    const worker = boot({ handlers: { draft }, intervalMs: 20 }); await worker.ready;
    const id = await stage(); await queue.enqueue(id, 0, 0, "h1");
    for (let attempt = 1; attempt <= 2; attempt++) {
      await waitFor(() => draft.mock.calls.length === attempt, "execution started");
      await waitFor(async () => (await queue.liveJobIds()).size === 0, "failed delivery settled");
      await db.pool.query("update stage_runs set lease_until = clock_timestamp() - interval '1 second' where id = $1", [id]);
    }
    await waitFor(async () => (await getStage(db.pool, id))?.status === "failed", "execution retry budget exhausted");
    expect(draft).toHaveBeenCalledTimes(2); expect((await getStage(db.pool, id))?.fence).toBe(2);
    expect((await db.pool.query("select * from spend_intents")).rows).toEqual([]);
  });

  it("render_limit_is_shared_across_two_worker_runtimes", async () => {
    const hold = deferred(); let active = 0; let peak = 0;
    const render = vi.fn(async () => { peak = Math.max(peak, ++active); await hold.promise; active--; return {}; });
    const a = boot({ handlers: { render }, workerId: "render-a" });
    const b = boot({ handlers: { render }, workerId: "render-b", hooks: { connectQueue: async () => createJobQueue(db.redisUrl, "stages", queue.name.slice(7)) } });
    await Promise.all([a.ready, b.ready]);
    const ids = await Promise.all([stage("render"), stage("render")]);
    await Promise.all(ids.map((id) => queue.enqueue(id, 0, 0, "h1")));
    try {
      await waitFor(async () => {
        if (render.mock.calls.length === 0) return false;
        const rows = await Promise.all(ids.map((id) => getStage(db.pool, id)));
        return rows.every((r) => r?.status === "running") || (await queue.liveJobIds()).size === 1;
      }, "both render deliveries decided");
      expect(render).toHaveBeenCalledTimes(1);
      expect((await Promise.all(ids.map((id) => getStage(db.pool, id)))).map((r) => r!.status).sort()).toEqual(["queued", "running"]);
    } finally { hold.resolve(); }
    await waitFor(async () => (await Promise.all(ids.map((id) => getStage(db.pool, id)))).some((r) => r?.status === "succeeded"), "render capacity released");
    await reconcile(db.pool, queue, { graceMs: 0 });
    await waitFor(async () => (await Promise.all(ids.map((id) => getStage(db.pool, id)))).every((r) => r?.status === "succeeded"), "second render recovered");
    expect(peak).toBe(1);
  });

  it("shutdown_deadline_terminates_a_blocked_owned_database_query", async () => {
    const pool = createPool(db.pool.options.connectionString!);
    const query = pool.query("select pg_sleep(60)").catch(() => undefined);
    await waitFor(() => pool.totalCount > 0, "worker pool connected");
    const worker = boot({ pool, shutdownTimeoutMs: 100 }); await worker.ready;
    const before = Date.now();
    await Promise.race([worker.stop(), new Promise<never>((_, reject) => { const t = setTimeout(() => reject(new Error("shutdown hung")), 2000); t.unref(); })]);
    expect(Date.now() - before).toBeLessThan(1500);
    await query;
    await waitFor(() => pool.totalCount === 0, "owned pool fully closed");
  });

  it("worker_that_dies_is_replaced_by_the_supervisor", async () => {
    // dev:all uses concurrently --restart-tries -1. Model its kill/restart with actual child processes.
    const script = fileURLToPath(new URL("./helpers/runtime-process.ts", import.meta.url));
    const spawnRuntime = (block: boolean) => {
      const child = spawn(process.execPath, ["--import", "tsx", script], {
        cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, DATABASE_URL: db.pool.options.connectionString!, REDIS_URL: db.redisUrl,
          QUEUE_SUFFIX: queue.name.slice(7), WORKER_ID: block ? "dead" : "replacement", BLOCK_HANDLER: block ? "1" : "0" },
      });
      children.push(child);
      let output = "";
      child.stdout!.on("data", (d) => { output += d; }); child.stderr!.on("data", (d) => { output += d; });
      return { child, async marker(text: string) {
        await waitFor(() => {
          if (output.split("\n").includes(text)) return true;
          if (child.exitCode !== null) throw new Error(`child exited: ${output}`);
          return false;
        }, text);
      } };
    };
    const first = spawnRuntime(true); await first.marker("READY");
    const id = await stage(); await queue.enqueue(id, 0, 0, "h1"); await first.marker("HANDLER_STARTED");
    const exited = once(first.child, "exit"); first.child.kill("SIGKILL"); await exited;
    expect(await getStage(db.pool, id)).toMatchObject({ status: "running", fence: 1, leaseOwner: "dead" });
    await db.pool.query("update stage_runs set lease_until = clock_timestamp() - interval '1 second' where id = $1", [id]);
    const second = spawnRuntime(false); await second.marker("READY");
    await waitFor(async () => (await getStage(db.pool, id))?.status === "succeeded", "replacement recovered stage");
    expect(await getStage(db.pool, id)).toMatchObject({ fence: 2, attemptSeq: 1, leaseOwner: "replacement" });
  });

  it("shutdown_mid_job_requeues_for_next_boot", async () => {
    const first = boot({ handlers: { draft: async () => new Promise(() => {}) }, workerId: "first" }); await first.ready;
    const id = await stage(); await queue.enqueue(id, 0, 0, "h1");
    await waitFor(async () => (await getStage(db.pool, id))?.status === "running", "claimed");
    await first.stop();
    expect(await getStage(db.pool, id)).toMatchObject({ status: "running", leaseOwner: "first", fence: 1 });
    await db.pool.query("update stage_runs set lease_until = clock_timestamp() - interval '1 second' where id = $1", [id]);
    queue = createJobQueue(db.redisUrl, "stages", `reboot-${process.pid}-${seq++}`);
    const draft = vi.fn(async () => ({ restarted: true }));
    const second = boot({ handlers: { draft }, workerId: "second" }); await second.ready;
    await waitFor(async () => (await getStage(db.pool, id))?.status === "succeeded", "next boot reclaimed");
    expect(await getStage(db.pool, id)).toMatchObject({ fence: 2, attemptSeq: 1, result: { restarted: true } });
    expect(draft).toHaveBeenCalledTimes(1);
  });
});

describe("worker live feed and job logs", () => {
  let root: string; let prevRoot: string | undefined;
  beforeEach(async () => { prevRoot = process.env.STORAGE_ROOT; root = await mkdtemp(path.join(os.tmpdir(), "wk-logs-")); process.env.STORAGE_ROOT = root; });
  afterEach(async () => { if (prevRoot === undefined) delete process.env.STORAGE_ROOT; else process.env.STORAGE_ROOT = prevRoot; await rm(root, { recursive: true, force: true }); });
  const types = async () => (await db.pool.query("select type from events order by id")).rows.map((r) => r.type as string);

  it("stage_outcomes_and_ctx_log_reach_the_events_table_and_a_redacted_log_file", async () => {
    const worker = boot({ handlers: { draft: async (ctx) => { ctx.log("working with sk-ant-api03-abcdefghijklmnopqrstuvwxyz"); ctx.log("done"); return { ok: true }; } } }); await worker.ready;
    const id = await stage(); await queue.enqueue(id, 0, 0, "h1");
    await waitFor(async () => (await types()).includes("stage.succeeded"), "success event");
    const t = await types();
    expect(t[0]).toBe("stage.started"); expect(t).toContain("log"); expect(t.at(-1)).toBe("stage.succeeded");
    const row = (await getStage(db.pool, id))!;
    const text = await readFile(path.join(root, "videos", row.videoId, "logs", `draft-${row.fence}.log`), "utf8");
    expect(text).toContain("done"); expect(text).not.toContain("sk-ant");
    expect(JSON.stringify((await db.pool.query("select payload from events")).rows)).not.toContain("sk-ant");
  });

  it("failed_stage_emits_stage_failed", async () => {
    const worker = boot({ handlers: { render: async () => ({}) } }); await worker.ready;
    const id = await stage(); await queue.enqueue(id, 0, 0, "h1");
    await waitFor(async () => (await types()).includes("stage.failed"), "failed event");
  });

  it("a_throwing_event_hook_does_not_break_the_job", async () => {
    const bad = boot({ handlers: { draft: async (ctx) => { ctx.log("x"); return { ok: true }; } }, hooks: { emitEvent: async () => { throw new Error("events down"); } } }); await bad.ready;
    const id = await stage(); await queue.enqueue(id, 0, 0, "h1");
    await waitFor(async () => (await getStage(db.pool, id))?.status === "succeeded", "stage still succeeds");
  });

  it("the_prune_hook_removes_week_old_events_through_prune_events", async () => {
    await db.pool.query("insert into events (type, at) values ('log', now() - interval '8 days'), ('log', now())");
    const worker = boot({ intervalMs: 20 }); await worker.ready;
    await waitFor(async () => (await db.pool.query("select 1 from events")).rowCount === 1, "old event pruned");
  });
});
