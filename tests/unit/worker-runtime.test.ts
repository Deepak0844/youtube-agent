import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startReconcileLoop } from "@/worker/reconcile-loop";
import { createStageDispatcher } from "@/worker/handlers";
import { startWorker } from "@/worker";
import type { StageContext } from "@/server/core/stage-handler";
import type { StageJob } from "@/server/core/stage-runner";
import type { StageQueue } from "@/server/queue/job-queue";
import { buildEngineConfig } from "@/server/core/engine-config";
import type { WorkerOptions } from "@/worker/runtime";

const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
afterEach(() => vi.useRealTimers());

describe("worker runtime", () => {
  it("reconcile_loop_runs_on_start_and_does_not_overlap_itself", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const run = vi.fn(() => new Promise<void>((r) => { release = r; }));
    const loop = startReconcileLoop({ run, intervalMs: 15_000, log: vi.fn() });
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(run).toHaveBeenCalledTimes(1);
    release(); await tick();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(run).toHaveBeenCalledTimes(2);
    const stopped = loop.stop(); release(); await stopped;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("job_for_unknown_stage_name_fails_cleanly", async () => {
    const dispatch = createStageDispatcher({}, 1);
    const ctx = { stage: { name: "__proto__" }, signal: new AbortController().signal } as StageContext;
    await expect(dispatch(ctx)).rejects.toThrow("unknown stage");
    ctx.stage.name = "draft";
    await expect(dispatch(ctx)).rejects.toThrow("missing stage handler");
  });

  it("render_semaphore_serialises_render_stages", async () => {
    let active = 0; let peak = 0;
    const releases: Array<() => void> = [];
    const render = vi.fn(async () => {
      peak = Math.max(peak, ++active);
      await new Promise<void>((r) => releases.push(r));
      active--; return {};
    });
    const dispatch = createStageDispatcher({ render }, 1);
    const ctx = { stage: { name: "render" }, signal: new AbortController().signal } as StageContext;
    const a = dispatch(ctx); const b = dispatch(ctx);
    await tick(); expect(render).toHaveBeenCalledTimes(1);
    releases.shift()!(); await tick(); expect(render).toHaveBeenCalledTimes(2);
    releases.shift()!(); await Promise.all([a, b]); expect(peak).toBe(1);
  });

  it("worker_starts_stops_and_logs_without_redis_when_redis_is_down", async () => {
    vi.useFakeTimers();
    const log = vi.fn(); const connect = vi.fn().mockRejectedValue(new Error("offline"));
    const end = vi.fn().mockResolvedValue(undefined);
    const worker = startWorker({
      pool: { end } as unknown as WorkerOptions["pool"], redisUrl: "redis://127.0.0.1:1", log,
      hooks: {
        connectQueue: connect,
        loadSettings: async () => ({ config: (await import("@/server/core/engine-config")).buildEngineConfig(new Map()), concurrentJobs: 2, concurrentRenders: 1 }),
        checkVault: async () => "missing_key",
      }, retryMs: 100,
    });
    await worker.ready; expect(log).toHaveBeenCalledWith("waiting for Redis");
    await vi.advanceTimersByTimeAsync(300);
    expect(connect.mock.calls.length).toBeGreaterThan(1);
    await worker.stop(); expect(end).toHaveBeenCalledTimes(1);
    const n = connect.mock.calls.length; await vi.advanceTimersByTimeAsync(300);
    expect(connect).toHaveBeenCalledTimes(n);
    expect(log).toHaveBeenLastCalledWith("worker stopped");
  });

  it("shutdown_aborts_and_bounds_drain_before_closing_resources", async () => {
    vi.useFakeTimers();
    const pause = vi.fn().mockResolvedValue(undefined);
    const closeConsumer = vi.fn().mockResolvedValue(undefined);
    const closeQueue = vi.fn().mockResolvedValue(undefined);
    const end = vi.fn().mockResolvedValue(undefined);
    let processor!: (job: StageJob, id: string) => Promise<void>;
    let signal!: AbortSignal;
    const queue = {
      startWorker: (handler: typeof processor) => { processor = handler; return { pause, close: closeConsumer }; },
      close: closeQueue,
    } as unknown as StageQueue;
    const worker = startWorker({
      pool: { end } as unknown as WorkerOptions["pool"], redisUrl: "redis://unused", log: vi.fn(), shutdownTimeoutMs: 100,
      hooks: {
        connectQueue: async () => queue,
        loadSettings: async () => ({ config: buildEngineConfig(new Map()), concurrentJobs: 2, concurrentRenders: 1 }),
        checkVault: async () => "missing_key", reconcile: async () => {}, advanceAll: async () => {},
        markStalled: async () => {}, prune: async () => {},
        runStage: async (_db, deps) => { signal = deps.shutdownSignal!; return new Promise(() => {}); },
      },
    });
    await worker.ready;
    void processor({ stageRunId: "stage", inputHash: "h1" }, "job");
    const stopped = worker.stop(); expect(worker.stop()).toBe(stopped);
    expect(pause).toHaveBeenCalledTimes(1); expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(99); expect(closeConsumer).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await stopped;
    expect(closeConsumer).toHaveBeenCalledWith(true); expect(closeQueue).toHaveBeenCalledWith(true);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("database_maintenance_runs_immediately_and_each_tick_while_redis_is_down", async () => {
    vi.useFakeTimers();
    const markStalled = vi.fn().mockResolvedValue([]); const prune = vi.fn().mockResolvedValue(undefined);
    const reconcile = vi.fn(); const advanceAll = vi.fn();
    const worker = startWorker({
      pool: { end: vi.fn().mockResolvedValue(undefined) } as unknown as WorkerOptions["pool"], redisUrl: "redis://unused", log: vi.fn(),
      intervalMs: 100, retryMs: 100,
      hooks: {
        loadSettings: async () => ({ config: buildEngineConfig(new Map()), concurrentJobs: 2, concurrentRenders: 1 }),
        checkVault: async () => "missing_key", connectQueue: async () => { throw new Error("offline"); },
        markStalled, prune, reconcile, advanceAll,
      },
    });
    await worker.ready; expect(markStalled).toHaveBeenCalledTimes(1); expect(prune).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(400);
    expect(markStalled.mock.calls.length).toBeGreaterThan(3); expect(prune.mock.calls.length).toBeGreaterThan(3);
    expect(reconcile).not.toHaveBeenCalled(); expect(advanceAll).not.toHaveBeenCalled(); await worker.stop();
  });

  it("shutdown_deadline_bounds_blocked_teardown_and_cleanup_failures_are_independent", async () => {
    vi.useFakeTimers();
    const closeConsumer = vi.fn().mockRejectedValue(new Error("close failed"));
    const closeQueue = vi.fn(() => new Promise<void>(() => {}));
    const end = vi.fn(() => new Promise<void>(() => {}));
    const queue = { startWorker: () => ({ pause: async () => {}, close: closeConsumer }), close: closeQueue } as unknown as StageQueue;
    const worker = startWorker({
      pool: { end } as unknown as WorkerOptions["pool"], redisUrl: "redis://unused", log: vi.fn(), shutdownTimeoutMs: 100,
      hooks: {
        connectQueue: async () => queue,
        loadSettings: async () => ({ config: buildEngineConfig(new Map()), concurrentJobs: 2, concurrentRenders: 1 }),
        checkVault: async () => "missing_key", reconcile: async () => {}, advanceAll: async () => {}, markStalled: async () => {},
      },
    });
    await worker.ready;
    const stopped = worker.stop();
    // Observe a rejection immediately so RED does not create an unhandled rejection.
    const result = stopped.then(() => "stopped", () => "rejected");
    await vi.advanceTimersByTimeAsync(100);
    expect(await Promise.race([result, Promise.resolve("still pending")])).toBe("stopped");
    expect(closeConsumer).toHaveBeenCalledTimes(1); expect(closeQueue).toHaveBeenCalledTimes(1); expect(end).toHaveBeenCalledTimes(1);
  });

  it("env_file_missing_gives_a_plain_error", () => {
    const env = { ...process.env }; delete env.DATABASE_URL; delete env.REDIS_URL;
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/worker/index.ts"], { env, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DATABASE_URL is not set");
    expect(result.stderr).toContain(".env.local");
    expect(result.stderr).not.toContain("at main");
  });
});
