import { randomUUID } from "node:crypto";
import type pg from "pg";
import { Redis } from "ioredis";
import type { EngineConfig } from "@/server/core/engine-config";
import { createPool } from "@/server/db/pool";
import { getWorkerSettings, type WorkerSettings } from "@/server/db/engine-config";
import { loadKeyring } from "@/server/db/master-key";
import { vaultStatus } from "@/server/db/vault";
import { reconcile } from "@/server/db/reconciler";
import { advanceAll } from "@/server/db/pipeline";
import { markStalled } from "@/server/db/uploads";
import { runStage } from "@/server/db/stage-runner-adapter";
import { createJobQueue, type StageQueue } from "@/server/queue/job-queue";
import { createStageDispatcher, type StageHandlers } from "./handlers";
import { startReconcileLoop } from "./reconcile-loop";

// Composition seams for boot cleanup (09), event retention/transitions (11), and notifications (12).
export interface WorkerHooks {
  connectQueue(redisUrl: string, log: (message: string) => void): Promise<StageQueue>;
  loadSettings(pool: pg.Pool): Promise<WorkerSettings>;
  checkVault(pool: pg.Pool): Promise<string>;
  reconcile(pool: pg.Pool, queue: StageQueue, config: EngineConfig): Promise<unknown>;
  advanceAll(pool: pg.Pool, queue: StageQueue): Promise<unknown>;
  markStalled(pool: pg.Pool): Promise<unknown>;
  prune(pool: pg.Pool): Promise<void>;
  runStage: typeof runStage;
  beforeStart(pool: pg.Pool): Promise<void>;
}
export interface WorkerOptions {
  pool?: pg.Pool;
  redisUrl?: string;
  handlers?: StageHandlers;
  workerId?: string;
  log?: (message: string) => void;
  hooks?: Partial<WorkerHooks>;
  intervalMs?: number;
  retryMs?: number;
  shutdownTimeoutMs?: number;
}

async function connectQueue(redisUrl: string, log: (message: string) => void): Promise<StageQueue> {
  // Do not construct BullMQ until Redis answers: this keeps startup and shutdown bounded during an outage.
  const probe = new Redis(redisUrl, { lazyConnect: true, connectTimeout: 1000, maxRetriesPerRequest: 1, retryStrategy: () => null });
  probe.on("error", () => {});
  try { await probe.connect(); await probe.ping(); }
  finally { probe.disconnect(); }
  return createJobQueue(redisUrl, "stages", undefined, { onError: () => log("waiting for Redis") });
}
const defaults: WorkerHooks = {
  connectQueue,
  loadSettings: getWorkerSettings,
  checkVault: async (pool) => (await vaultStatus(pool, loadKeyring)).status,
  reconcile: (pool, queue, config) => reconcile(pool, queue, { maxAttempts: config.retryAttempts - 1 }),
  advanceAll,
  runStage,
  markStalled: (pool) => markStalled(pool, 60_000),
  // Event storage is introduced by Task 11. Never invent a table or use an owner pool here.
  prune: async () => {},
  beforeStart: async () => {},
};

export function startRuntime(opts: WorkerOptions = {}) {
  const log = opts.log ?? console.log;
  const hooks = { ...defaults, ...opts.hooks };
  const shutdown = new AbortController();
  const workerId = opts.workerId ?? randomUUID();
  let pool = opts.pool;
  let queue: StageQueue | undefined;
  let consumer: ReturnType<StageQueue["startWorker"]> | undefined;
  let loop: ReturnType<typeof startReconcileLoop> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  let connecting: Promise<void> | undefined;
  const active = new Set<Promise<unknown>>();
  log("worker started");

  const ready = (async () => {
    if (!pool) {
      if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set; configure .env.local before starting the worker");
      pool = createPool(process.env.DATABASE_URL);
    }
    const db = pool;
    const redisUrl = opts.redisUrl ?? process.env.REDIS_URL;
    if (!redisUrl) throw new Error("REDIS_URL is not set; configure .env.local before starting the worker");
    const settings = await hooks.loadSettings(db);
    if (stopping) return;
    try { log(`vault ${await hooks.checkVault(db)}`); }
    catch { log("vault unreadable"); }
    await hooks.beforeStart(db);
    if (stopping) return;
    const dispatch = createStageDispatcher(opts.handlers ?? {}, settings.concurrentRenders);
    const connect = (): Promise<void> => {
      connecting = (async () => {
        try {
          const connected = await hooks.connectQueue(redisUrl, log);
          if (stopping) { await connected.close(true); return; }
          queue = connected;
          consumer = queue.startWorker(async (job) => {
            if (stopping) return;
            const attempt = hooks.runStage(db, {
              workerId, ttlMs: settings.config.leaseS * 1000, config: settings.config,
              concurrencyLimit: settings.concurrentJobs,
              handler: dispatch, shutdownSignal: shutdown.signal,
              provider: { call: async () => { throw new Error("runtime requires a stage handler"); } },
            }, job);
            active.add(attempt);
            try { await attempt; }
            finally { active.delete(attempt); }
          }, { concurrency: settings.concurrentJobs, onError: () => log("waiting for Redis") });
          loop = startReconcileLoop({
            intervalMs: opts.intervalMs, log,
            async run() {
              // A Redis failure must not prevent upload liveness and retention maintenance.
              const results = await Promise.allSettled([
                (async () => { await hooks.reconcile(db, connected, settings.config); if (!stopping) await hooks.advanceAll(db, connected); })(),
                hooks.markStalled(db), hooks.prune(db),
              ]);
              if (results.some((r) => r.status === "rejected")) throw new Error("maintenance failed");
              log("reconcile ok");
            },
          });
        } catch {
          if (!stopping) {
            log("waiting for Redis");
            retry = setTimeout(() => { void connect(); }, opts.retryMs ?? 15_000);
          }
        }
      })();
      return connecting;
    };
    await connect();
  })();
  // Consumers may use ready for boot diagnostics; ignoring it must never create an unhandled rejection.
  void ready.catch(() => log("worker configuration or database unavailable; check .env.local"));

  return {
    ready,
    stop(): Promise<void> {
      if (stopPromise) return stopPromise;
      stopping = true;
      clearTimeout(retry);
      // pause(true) stops fetching without waiting on active handlers. Abort only after consumption is paused.
      const pause = consumer?.pause?.();
      shutdown.abort();
      stopPromise = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const draining = Promise.allSettled([ready, connecting, pause, loop?.stop(), ...active]);
        try {
          await Promise.race([draining, new Promise<void>((r) => { timer = setTimeout(r, opts.shutdownTimeoutMs ?? 10_000); })]);
        } finally { clearTimeout(timer); }
        await consumer?.close(true);
        await queue?.close(true);
        await pool?.end();
        log("worker stopped");
      })();
      return stopPromise;
    },
  };
}
