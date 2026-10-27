import { randomUUID } from "node:crypto";
import type pg from "pg";
import { Redis } from "ioredis";
import { stagePlan } from "@/server/core/pipeline-plan";
import type { EngineConfig } from "@/server/core/engine-config";
import { createPool, forceClosePool } from "@/server/db/pool";
import { getWorkerSettings, type WorkerSettings } from "@/server/db/engine-config";
import { loadKeyring } from "@/server/db/master-key";
import { vaultStatus } from "@/server/db/vault";
import { reconcile, type ReconcileResult } from "@/server/db/reconciler";
import { advanceAll } from "@/server/db/pipeline";
import { notifyTransition, type NotifyPorts } from "@/server/db/notify";
import { getStage } from "@/server/db/stages";
import type { StageOutcome } from "@/server/core/stage-runner";
import type { NotifyEventId } from "@/server/core/notify";
import { createChildRegistry, holdWorkerLock, sweepOrphans, type WorkerLock } from "@/server/db/child-processes";
import type { ChildRegistry } from "@/server/render/child";
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
  /** Boot order matters: sweep children left by dead workers first, then claim this worker id. */
  sweepOrphans(pool: pg.Pool, workerId: string): Promise<number>;
  holdWorkerLock(pool: pg.Pool, workerId: string): Promise<WorkerLock>;
  createChildRegistry(pool: pg.Pool, workerId: string): ChildRegistry;
}
export interface WorkerOptions {
  pool?: pg.Pool;
  redisUrl?: string;
  /** Handlers, or a factory that receives the registry render children must be registered with (so a crash leaves them sweepable). */
  handlers?: StageHandlers | ((env: { childRegistry: ChildRegistry }) => StageHandlers);
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
  sweepOrphans, holdWorkerLock, createChildRegistry,
};

// Stage outcomes the owner must hear about. A redelivered job reuses (stage id, fence), so it notifies once.
const NOTIFY_OUTCOMES: Partial<Record<StageOutcome["kind"], { event: NotifyEventId; to: string }>> = {
  needs_decision: { event: "needs_decision", to: "needs_decision" },
  budget_refused: { event: "needs_decision", to: "needs_decision" },
  known_failure_release_failed: { event: "needs_decision", to: "needs_decision" },
  known_failure: { event: "video_failed", to: "failed" },
  timed_out: { event: "video_failed", to: "failed" },
};

const describe = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 300);

/*
 * Design notes (no behaviour change intended):
 * - attemptBasis "claim": the reconciler's retry cap counts claims (fence), not re-enqueues. Work refused only for
 *   capacity, or lost from Redis, therefore never exhausts its budget. Consequences: a failure BEFORE a claim (for
 *   example stepsFor throwing before the first claim) is not capped by this counter, and a graceful shutdown that
 *   aborts a running stage burns one fence (counts as one try).
 * - Render cap: renderStageNames come from the scene_kit/short plan only; other plan variants with extra render
 *   stages would not be counted against concurrent_renders.
 * - The queue uses enableOfflineQueue:false, so a Redis blip fails jobs fast instead of buffering them. Postgres stays
 *   authoritative: the reconciler re-enqueues from rows, so no work is lost.
 */
export function startRuntime(opts: WorkerOptions = {}) {
  const log = opts.log ?? console.log;
  const hooks = { ...defaults, ...opts.hooks };
  const shutdown = new AbortController();
  const workerId = opts.workerId ?? randomUUID();
  let pool = opts.pool;
  let workerLock: WorkerLock | undefined;
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
    const swept = await hooks.sweepOrphans(db, workerId);
    if (swept > 0) log(`swept ${swept} orphaned child process(es)`);
    workerLock = await hooks.holdWorkerLock(db, workerId);
    if (stopping) return;
    const childRegistry = hooks.createChildRegistry(db, workerId);
    const handlers = typeof opts.handlers === "function" ? opts.handlers({ childRegistry }) : (opts.handlers ?? {});
    const hasHandlers = Object.keys(handlers).length > 0;
    if (!hasHandlers) log("no stage handlers registered; stages stay queued and are not consumed or advanced");
    const dispatch = createStageDispatcher(handlers, settings.concurrentRenders);
    const renderStageNames = stagePlan("scene_kit", "short", { paidGeneration: true, requireEvidence: true }).filter((s) => s.resource === "render").map((s) => s.stage);
    // Reconciler paths that park (unknown paid outcome) or fail (too many attempts) a stage tell the owner too.
    // Same (stage id, fence) key as the runner path, so one stage state notifies once.
    const notifyReconciled = async (database: pg.Pool, result: unknown) => {
      const r = result as Partial<ReconcileResult> | undefined;
      const items: Array<[string, NotifyEventId, string]> = [
        ...(r?.needsDecision ?? []).map((id): [string, NotifyEventId, string] => [id, "needs_decision", "needs_decision"]),
        ...(r?.failed ?? []).map((id): [string, NotifyEventId, string] => [id, "video_failed", "failed"]),
      ];
      for (const [id, event, to] of items) {
        try {
          const row = await getStage(database, id);
          await hooks.notify(database, { channels: {} }, { event, videoId: row?.videoId, from: "running", to, transitionId: `${id}.${row?.fence ?? 0}`, detail: row?.name });
        } catch { log("notify failed"); }
      }
    };
    // DB-only upkeep starts before Redis and continues through outages. Queue-dependent transitions require
    // a successful availability check; one single-flight loop owns both halves.
    loop = startReconcileLoop({
      intervalMs: opts.intervalMs, log,
      async run() {
        const connected = queue;
        const failures: string[] = [];
        const guard = async (name: string, fn: () => Promise<unknown>) => {
          try { await fn(); } catch (err) { failures.push(`${name}: ${describe(err)}`); }
        };
        await Promise.all([
          guard("queue maintenance", async () => {
            if (!connected || stopping) return;
            try { await connected.liveJobIds?.(); } catch { log("waiting for Redis"); throw new Error("Redis unavailable"); }
            const result = await hooks.reconcile(db, connected, settings.config);
            await notifyReconciled(db, result);
            // Without handlers every stage would fail as "missing handler"; leave rows queued instead.
            if (!stopping && hasHandlers) await hooks.advanceAll(db, connected);
          }),
          guard("mark stalled uploads", () => hooks.markStalled(db)),
          guard("prune", () => hooks.prune(db)),
        ]);
        if (failures.length) throw new Error(failures.join("; "));
        if (connected && !stopping) log("reconcile ok");
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
          // Without handlers there is no consumer: jobs wait in Redis and rows stay queued.
          if (hasHandlers) consumer = queue.startWorker(async (job) => {
            if (stopping) return;
            // The whole job (run, commit/settle, notice) is tracked, so a clean stop waits for it before the pool closes.
            const whole = (async () => {
              const outcome = await hooks.runStage(db, {
                workerId, ttlMs: settings.config.leaseS * 1000, config: settings.config,
                concurrencyLimit: settings.concurrentJobs,
                renderConcurrencyLimit: settings.concurrentRenders, renderStageNames,
                handler: dispatch, shutdownSignal: shutdown.signal,
                provider: { call: async () => { throw new Error("runtime requires a stage handler"); } },
              }, job);
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
            })();
            active.add(whole);
            try { await whole; } finally { active.delete(whole); }
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
      stopPromise = (async () => {
        const limitMs = opts.shutdownTimeoutMs ?? 10_000;
        const within = async (work: Promise<unknown>): Promise<boolean> => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const expired = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), limitMs); });
          try { return await Promise.race([work.then(() => false), expired]); } finally { clearTimeout(timer); }
        };
        // Drain in two halves. First let in-flight jobs finish on their own (commit/settle included) so a plain
        // SIGTERM does not turn a nearly-done job into a parked one. Then abort what is left and wait the rest.
        const drain = Promise.allSettled([ready, connecting, pause, loop?.stop(), ...active]);
        const half = Math.floor(limitMs / 2);
        let t: ReturnType<typeof setTimeout> | undefined;
        const early = await Promise.race([drain.then(() => true), new Promise<boolean>((r) => { t = setTimeout(() => r(false), half); })]);
        clearTimeout(t);
        if (!early) {
          shutdown.abort();
          let t2: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([drain, new Promise<void>((r) => { t2 = setTimeout(r, limitMs - half); })]);
          clearTimeout(t2);
        }
        // Teardown has its own fresh limit, so a slow drain cannot starve closing connections.
        const teardownExpired = await within(Promise.allSettled([
          safely(() => consumer?.close(true)), safely(() => queue?.close(true)), safely(async () => { await workerLock?.release(); await pool?.end(); }),
        ]));
        if (teardownExpired) {
          if (pool) forceClosePool(pool);
          void safely(() => queue?.disconnect?.()).catch(() => {});
          log("worker shutdown deadline reached; connections terminated");
        }
        log("worker stopped");
      })();
      return stopPromise;
    },
  };
}
