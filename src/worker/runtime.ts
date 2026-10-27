import { randomUUID } from "node:crypto";
import type pg from "pg";
import { Redis } from "ioredis";
import { stagePlan } from "@/server/core/pipeline-plan";
import type { EngineConfig } from "@/server/core/engine-config";
import { createPool, forceClosePool } from "@/server/db/pool";
import { getWorkerSettings, type WorkerSettings } from "@/server/db/engine-config";
import { loadKeyring } from "@/server/db/master-key";
import { vaultStatus } from "@/server/db/vault";
import { reconcile } from "@/server/db/reconciler";
import { advanceAll } from "@/server/db/pipeline";
import { notifyTransition, type NotifyPorts } from "@/server/db/notify";
import { getStage } from "@/server/db/stages";
import type { StageOutcome } from "@/server/core/stage-runner";
import type { NotifyEventId } from "@/server/core/notify";
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
  /** Called after a stage ends in a state the owner must hear about. Best-effort: never throws into the job. */
  notify(pool: pg.Pool, ports: NotifyPorts, e: Parameters<typeof notifyTransition>[2]): Promise<unknown>;
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
  reconcile: (pool, queue, config) => reconcile(pool, queue, { maxAttempts: config.retryAttempts - 1, attemptBasis: "claim" }),
  advanceAll,
  runStage,
  notify: notifyTransition,
  markStalled: (pool) => markStalled(pool, 60_000),
  // Event storage is introduced by Task 11. Never invent a table or use an owner pool here.
  prune: async () => {},
  beforeStart: async () => {},
};

// Stage outcomes the owner must hear about. A redelivered job reuses (stage id, fence), so it notifies once.
const NOTIFY_OUTCOMES: Partial<Record<StageOutcome["kind"], { event: NotifyEventId; to: string }>> = {
  needs_decision: { event: "needs_decision", to: "needs_decision" },
  budget_refused: { event: "needs_decision", to: "needs_decision" },
  known_failure_release_failed: { event: "needs_decision", to: "needs_decision" },
  known_failure: { event: "video_failed", to: "failed" },
  timed_out: { event: "video_failed", to: "failed" },
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
    const renderStageNames = stagePlan("scene_kit", "short", { paidGeneration: true, requireEvidence: true }).filter((s) => s.resource === "render").map((s) => s.stage);
    // DB-only upkeep starts before Redis and continues through outages. Queue-dependent transitions require
    // a successful availability check; one single-flight loop owns both halves.
    loop = startReconcileLoop({
      intervalMs: opts.intervalMs, log,
      async run() {
        const connected = queue;
        const results = await Promise.allSettled([
          (async () => {
            if (!connected || stopping) return;
            try {
              await connected.liveJobIds?.();
              await hooks.reconcile(db, connected, settings.config);
              if (!stopping) await hooks.advanceAll(db, connected);
              log("reconcile ok");
            } catch { log("waiting for Redis"); throw new Error("queue maintenance unavailable"); }
          })(),
          hooks.markStalled(db), hooks.prune(db),
        ]);
        if (results.some((r) => r.status === "rejected")) throw new Error("maintenance failed");
      },
    });
    const connect = (): Promise<void> => {
      connecting = (async () => {
        try {
          const connected = await hooks.connectQueue(redisUrl, log);
          if (stopping) {
            void Promise.resolve().then(() => connected.close(true)).catch(() => {});
            void Promise.resolve().then(() => connected.disconnect?.()).catch(() => {});
            return;
          }
          queue = connected;
          consumer = queue.startWorker(async (job) => {
            if (stopping) return;
            const attempt = hooks.runStage(db, {
              workerId, ttlMs: settings.config.leaseS * 1000, config: settings.config,
              concurrencyLimit: settings.concurrentJobs,
              renderConcurrencyLimit: settings.concurrentRenders, renderStageNames,
              handler: dispatch, shutdownSignal: shutdown.signal,
              provider: { call: async () => { throw new Error("runtime requires a stage handler"); } },
            }, job);
            active.add(attempt);
            try {
              const outcome = await attempt;
              const hit = outcome && "claim" in outcome ? NOTIFY_OUTCOMES[outcome.kind] : undefined;
              if (hit && "claim" in outcome) {
                try {
                  const row = await getStage(db, outcome.claim.stageRunId);
                  await hooks.notify(db, { channels: {} }, {
                    event: hit.event, videoId: row?.videoId, from: "running", to: hit.to,
                    transitionId: `${outcome.claim.stageRunId}.${outcome.claim.fence}`, detail: row?.name,
                  });
                } catch { log("notify failed"); }
              }
            } finally { active.delete(attempt); }
          }, { concurrency: settings.concurrentJobs, onError: () => log("waiting for Redis") });
          await loop?.runNow();
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
      const safely = (fn: () => unknown) => { try { return Promise.resolve(fn()); } catch (err) { return Promise.reject(err); } };
      const pause = safely(() => consumer?.pause?.());
      shutdown.abort();
      stopPromise = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let expired = false;
        const deadline = new Promise<void>((resolve) => {
          timer = setTimeout(() => { expired = true; resolve(); }, opts.shutdownTimeoutMs ?? 10_000);
        });
        const draining = Promise.allSettled([ready, connecting, pause, loop?.stop(), ...active]);
        await Promise.race([draining, deadline]);
        // Start every cleanup even if another one throws. The same deadline bounds drain AND teardown.
        const cleanup = Promise.allSettled([
          safely(() => consumer?.close(true)), safely(() => queue?.close(true)), safely(() => pool?.end()),
        ]);
        await Promise.race([cleanup, deadline]);
        if (expired) {
          if (pool) forceClosePool(pool);
          void safely(() => queue?.disconnect?.()).catch(() => {});
          log("worker shutdown deadline reached; connections terminated");
        }
        clearTimeout(timer);
        log("worker stopped");
      })();
      return stopPromise;
    },
  };
}
