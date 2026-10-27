import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
    const worker = boot(); await worker.ready;
    const id = await stage("unrecognised"); await queue.enqueue(id, 0, 0, "h1");
    await waitFor(async () => (await getStage(db.pool, id))?.status === "failed", "unknown stage failed");
    expect((await getStage(db.pool, id))?.result).toMatchObject({ error: expect.stringContaining("unknown stage") });
  });

  it("missing_stage_handler_is_terminal_without_provider_fallback", async () => {
    const worker = boot(); await worker.ready;
    const id = await stage(); await queue.enqueue(id, 0, 0, "h1");
    await waitFor(async () => (await getStage(db.pool, id))?.status === "failed", "missing handler failed");
    expect((await getStage(db.pool, id))?.result).toEqual({ error: "known_failure: missing stage handler: draft" });
    expect((await db.pool.query("select * from spend_intents")).rows).toEqual([]);
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
    await waitFor(async () => (await Promise.all(ids.map((id) => getStage(db.pool, id)))).every((r) => r?.status === "running"), "both render attempts claimed");
    expect(render).toHaveBeenCalledTimes(1); hold.resolve();
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
