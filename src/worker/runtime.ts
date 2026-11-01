import { randomUUID } from "node:crypto";
import { safeReason } from "@/server/core/paid-call";
import { redactLine } from "@/server/core/log-redact";
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
import { NO_DECISIONS, type PipelineReaders } from "@/server/db/pipeline";
import { afterReconcile, afterStageOutcome, sweepRetries } from "@/server/db/retry";
import { notifyTransition, type NotifyPorts } from "@/server/db/notify";
import { getStage } from "@/server/db/stages";
import type { StageOutcome } from "@/server/core/stage-runner";
import type { NotifyEventId } from "@/server/core/notify";
import { createChildRegistry, holdWorkerLock, sweepOrphans, type WorkerLock } from "@/server/db/child-processes";
import type { ChildRegistry } from "@/server/render/child";
import { markStalled } from "@/server/db/uploads";
import { runStage } from "@/server/db/stage-runner-adapter";
import { createJobQueue, type IngestQueue, type StageQueue, type UploadQueue } from "@/server/queue/job-queue";
import type { Uploader } from "@/server/providers/uploader";
import { handlePublishUpload } from "./stages/publish-upload";
import { createEventBus, type EventBus } from "@/server/queue/event-bus";
import { pruneAgentSteps } from "@/server/db/agent-steps";
import { emitEvent, pruneEvents, type EventType } from "@/server/db/events";
import { openStageLog } from "@/server/logs/stage-log";
import { storageRoot } from "@/server/db/system-status";
import { queuedIngestIds } from "@/server/db/ingest-jobs";
import { runChild } from "@/server/render/child";
import { sweepLostAttempts } from "@/server/storage/store";
import { createStageDispatcher, handleIngestJob, recoverRunningIngest, sweepStaleUploads, type StageHandlers } from "./handlers";
import { startReconcileLoop } from "./reconcile-loop";

// Composition seams for boot cleanup (09), event retention/transitions (11), and notifications (12).
export interface WorkerHooks {
  connectQueue(redisUrl: string, log: (message: string) => void): Promise<StageQueue>;
  /** The `uploads` queue; connected only when an uploader was supplied. */
  connectUploadQueue(redisUrl: string, log: (message: string) => void): Promise<UploadQueue>;
  /** The `ingest` queue; connected only when the options ask for it (the real worker does). */
  connectIngestQueue(redisUrl: string, log: (message: string) => void): Promise<IngestQueue>;
  loadSettings(pool: pg.Pool): Promise<WorkerSettings>;
  checkVault(pool: pg.Pool): Promise<string>;
  reconcile(pool: pg.Pool, queue: StageQueue, config: EngineConfig): Promise<unknown>;
  advanceAll(pool: pg.Pool, queue: StageQueue, readers?: PipelineReaders): Promise<unknown>;
  /** Retries for confirmed provider rejections: repairs a crash between "failed" and "retry row" and releases held ones. */
  sweepRetries(pool: pg.Pool, queue: StageQueue, readers?: PipelineReaders): Promise<unknown>;
  sweepLostAttempts(db: pg.Pool, opts: { root: string }): Promise<unknown>;
  /** Breaker bookkeeping and the retry for one finished attempt. */
  afterOutcome: typeof afterStageOutcome;
  /** Breaker bookkeeping for stages the reconciler failed or parked. */
  afterReconcile: typeof afterReconcile;
  markStalled(pool: pg.Pool): Promise<unknown>;
  prune(pool: pg.Pool): Promise<void>;
  runStage: typeof runStage;
  /** Called after a stage ends in a state the owner must hear about. Best-effort: never throws into the job. */
  notify(pool: pg.Pool, ports: NotifyPorts, e: Parameters<typeof notifyTransition>[2]): Promise<unknown>;
  /** Live feed row + best-effort wake-up. Failures are caught by the caller: the feed never blocks a stage. */
  emitEvent: typeof emitEvent;
  createEventBus(redisUrl: string): EventBus;
  beforeStart(pool: pg.Pool): Promise<void>;
  /** Boot order matters: sweep children left by dead workers first, then claim this worker id. */
  sweepOrphans(pool: pg.Pool, workerId: string): Promise<number>;
  holdWorkerLock(pool: pg.Pool, workerId: string): Promise<WorkerLock>;
  createChildRegistry(pool: pg.Pool, workerId: string): ChildRegistry;
  /** After the lock: removes render containers a dead worker left (the real worker passes the docker sweep). Best effort. */
  sweepRenderContainers(pool: pg.Pool): Promise<number>;
}
export interface WorkerOptions {
  pool?: pg.Pool;
  redisUrl?: string;
  /** Handlers, or a factory that receives the registry render children must be registered with (so a crash leaves them sweepable). */
  handlers?: StageHandlers | ((env: { childRegistry: ChildRegistry; workerId: string }) => StageHandlers);
  /** Starts the `uploads` consumer. There is no default: with no uploader (real YouTube is Phase 5) approved uploads just wait. */
  uploader?: Uploader;
  /** Starts the `ingest` consumer (checks files uploaded through /api/uploads). Off by default, like the uploader. */
  ingest?: boolean;
  /** Where approved video files live; defaults to STORAGE_ROOT. */
  storageRoot?: string;
  workerId?: string;
  /** Where the pipeline reads owner decisions. The SAME readers go to advance, retry scheduling and the retry sweep. */
  readers?: PipelineReaders;
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
async function connectUploadQueue(redisUrl: string, log: (message: string) => void): Promise<UploadQueue> {
  return createJobQueue(redisUrl, "uploads", undefined, { onError: () => log("waiting for Redis") });
}
async function connectIngestQueue(redisUrl: string, log: (message: string) => void): Promise<IngestQueue> {
  return createJobQueue(redisUrl, "ingest", undefined, { onError: () => log("waiting for Redis") });
}
const defaults: WorkerHooks = {
  connectQueue, connectUploadQueue, connectIngestQueue,
  loadSettings: getWorkerSettings,
  checkVault: async (pool) => (await vaultStatus(pool, loadKeyring)).status,
  reconcile: (pool, queue, config) => reconcile(pool, queue, { maxAttempts: config.retryAttempts - 1, attemptBasis: "claim" }),
  advanceAll,
  sweepRetries: (pool, queue, readers) => sweepRetries(pool, queue, readers),
  sweepLostAttempts,
  afterOutcome: afterStageOutcome,
  afterReconcile,
  runStage,
  notify: notifyTransition,
  markStalled: (pool) => markStalled(pool, 60_000),
  // Retention for the events table through the owner-granted prune_events() (the app role cannot delete). One indexed
  // DELETE per loop tick.
  prune: async (pool) => { await pruneEvents(pool); await pruneAgentSteps(pool); },
  emitEvent, createEventBus,
  beforeStart: async () => {},
  sweepOrphans, holdWorkerLock, createChildRegistry,
  sweepRenderContainers: async () => 0,
};

// Stage outcomes the owner must hear about. A redelivered job reuses (stage id, fence), so it notifies once.
const NOTIFY_OUTCOMES: Partial<Record<StageOutcome["kind"], { event: NotifyEventId; to: string }>> = {
  needs_decision: { event: "needs_decision", to: "needs_decision" },
  budget_refused: { event: "needs_decision", to: "needs_decision" },
  known_failure_release_failed: { event: "needs_decision", to: "needs_decision" },
  known_failure: { event: "video_failed", to: "failed" },
  timed_out: { event: "video_failed", to: "failed" },
};

// Stage outcomes that end a stage as seen by the live feed. lease_lost / commit_rejected / noop say nothing: another
// attempt owns the stage now.
const OUTCOME_EVENTS: Partial<Record<StageOutcome["kind"], EventType>> = {
  committed: "stage.succeeded",
  known_failure: "stage.failed",
  timed_out: "stage.failed",
  needs_decision: "stage.needs_decision",
  budget_refused: "stage.needs_decision",
  known_failure_release_failed: "stage.needs_decision",
  cancelled: "stage.cancelled",
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
  const readers = opts.readers ?? NO_DECISIONS;
  let pool = opts.pool;
  let workerLock: WorkerLock | undefined;
  let queue: StageQueue | undefined;
  let bus: EventBus | undefined;
  let consumer: ReturnType<StageQueue["startWorker"]> | undefined;
  let uploadQueue: UploadQueue | undefined;
  let uploadConsumer: ReturnType<UploadQueue["startWorker"]> | undefined;
  let ingestQueue: IngestQueue | undefined;
  let ingestConsumer: ReturnType<IngestQueue["startWorker"]> | undefined;
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
    try { bus = hooks.createEventBus(redisUrl); } catch { bus = undefined; }
    const emit = async (e: Parameters<typeof emitEvent>[2]) => {
      try { await hooks.emitEvent(db, bus, e); } catch { log("event emit failed"); }
    };
    try { log(`vault ${await hooks.checkVault(db)}`); }
    catch { log("vault unreadable"); }
    await hooks.beforeStart(db);
    if (stopping) return;
    const swept = await hooks.sweepOrphans(db, workerId);
    if (swept > 0) log(`swept ${swept} orphaned child process(es)`);
    workerLock = await hooks.holdWorkerLock(db, workerId);
    if (stopping) return;
    const gone = await hooks.sweepRenderContainers(db).catch(() => 0);
    if (gone > 0) log(`removed ${gone} leftover render container(s)`);
    const childRegistry = hooks.createChildRegistry(db, workerId);
    const handlers = typeof opts.handlers === "function" ? opts.handlers({ childRegistry, workerId }) : (opts.handlers ?? {});
    const hasHandlers = Object.keys(handlers).length > 0;
    if (!hasHandlers) log("no stage handlers registered; stages stay queued and are not consumed or advanced");
    const dispatch = createStageDispatcher(handlers, settings.concurrentRenders);
    const renderStageNames = stagePlan("scene_kit", "short", { paidGeneration: true, requireEvidence: true }).filter((s) => s.resource === "render").map((s) => s.stage);
    // Reconciler paths that park (unknown paid outcome) or fail (too many attempts) a stage tell the owner too.
    // Same (stage id, fence) key as the runner path, so one stage state notifies once.
    const notifyBreaker = async (database: pg.Pool, opened: { stage: string; openedAtMs: number }) => {
      try {
        await hooks.notify(database, { channels: {} }, {
          event: "spend_cap_hit", from: "closed", to: "spend_cap_hit",
          transitionId: `breaker.${opened.stage}.${Math.round(opened.openedAtMs)}`,
          detail: `Stage "${opened.stage}" is paused after repeated failures. New ${opened.stage} work waits until the pause ends; you can reset it.`,
        });
      } catch { log("notify failed"); }
    };
    const notifyReconciled = async (database: pg.Pool, result: unknown) => {
      const r = result as Partial<ReconcileResult> | undefined;
      try { for (const o of await hooks.afterReconcile(database, r)) await notifyBreaker(database, o); } catch { log("breaker bookkeeping failed"); }
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
    let lastAttemptSweep = 0;
    const ATTEMPT_SWEEP_MS = 10 * 60_000; // a folder walk, not a 15 s job
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
            if (!stopping && hasHandlers) {
              await hooks.advanceAll(db, connected, readers);
              const swept = (await hooks.sweepRetries(db, connected, readers)) as { gaveUp?: string[] } | undefined;
              // A retry the sweep gave up on is the moment the owner hears "video failed" (same key as the runner path, so once).
              for (const id of swept?.gaveUp ?? []) {
                try {
                  const row = await getStage(db, id);
                  await hooks.notify(db, { channels: {} }, { event: "video_failed", videoId: row?.videoId, from: "running", to: "failed", transitionId: `${id}.${row?.fence ?? 0}`, detail: row?.name });
                } catch { log("notify failed"); }
              }
            }
          }),
          // Postgres decides what is queued; Redis may have lost the job (or the web process could not reach it). Job ids are unique per row, so re-adding is harmless.
          guard("ingest sweep", async () => {
            if (!ingestQueue || stopping) return;
            for (const id of await queuedIngestIds(db)) await ingestQueue.enqueueIngest(id);
            await sweepStaleUploads(db, opts.storageRoot ?? storageRoot());
          }),
          // Attempt folders whose fence was lost (a stale worker's output). DB read + file delete only; safe now that paid audio is fence-independent.
          guard("attempt sweep", async () => {
            if (stopping || Date.now() - lastAttemptSweep < ATTEMPT_SWEEP_MS) return;
            lastAttemptSweep = Date.now();
            await hooks.sweepLostAttempts(db, { root: opts.storageRoot ?? storageRoot() });
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
          // One upload at a time (Doc 02 4.7). The handler reads everything from Postgres and the disk; the payload is an id.
          if (opts.uploader && !uploadConsumer) {
            const uploader = opts.uploader;
            try {
              const uq = await hooks.connectUploadQueue(redisUrl, log);
              if (stopping) { void Promise.resolve().then(() => uq.close(true)).catch(() => {}); return; }
              uploadQueue = uq;
              uploadConsumer = uq.startWorker(async (uploadId) => {
                // Throw, never return: returning would acknowledge (and delete) a job that did not run. A failed job is
                // replaced by requeueUpload; the row is still publish_approved.
                if (stopping) throw new Error("worker is stopping; the upload was not started");
                const whole = handlePublishUpload(db, { uploader, root: opts.storageRoot }, uploadId).then(() => undefined);
                active.add(whole);
                try { await whole; } finally { active.delete(whole); }
              }, { concurrency: 1, onError: () => log("waiting for Redis") });
            } catch { log("uploads queue unavailable; approved uploads wait until the worker restarts"); }
          }
          if (opts.ingest && !ingestConsumer) {
            try {
              const iq = await hooks.connectIngestQueue(redisUrl, log);
              if (stopping) { void Promise.resolve().then(() => iq.close(true)).catch(() => {}); return; }
              ingestQueue = iq;
              // One worker holds the lock, so a row still `running` belongs to a dead one: finished, requeued or ended.
              await recoverRunningIngest(db, opts.storageRoot ?? storageRoot());
              ingestConsumer = iq.startWorker(async (jobId) => {
                if (stopping) throw new Error("worker is stopping; the ingest job was not started");
                const whole = handleIngestJob(db, { root: opts.storageRoot ?? storageRoot(), runChild: (spec) => runChild(spec, { registry: childRegistry }) }, jobId).then(() => undefined);
                active.add(whole);
                try { await whole; } finally { active.delete(whole); }
              }, { concurrency: 1, onError: () => log("waiting for Redis") });
            } catch { log("ingest queue unavailable; uploaded files wait until the worker restarts"); }
          }
          // Without handlers there is no consumer: jobs wait in Redis and rows stay queued.
          if (hasHandlers) consumer = queue.startWorker(async (job) => {
            if (stopping) return;
            // The whole job (run, commit/settle, notice) is tracked, so a clean stop waits for it before the pool closes.
            const whole = (async () => {
              // An unrecognised error leaves the row running until the lease expires; say why, redacted, then rethrow as before.
              const outcome = await hooks.runStage(db, {
                workerId, ttlMs: settings.config.leaseS * 1000, config: settings.config,
                concurrencyLimit: settings.concurrentJobs,
                renderConcurrencyLimit: settings.concurrentRenders, renderStageNames,
                handler: dispatch, shutdownSignal: shutdown.signal,
                openLog: (stage, claim) => {
                  const started = emit({ type: "stage.started", videoId: stage.videoId, stageRunId: stage.id, payload: { stage: stage.name, fence: claim.fence } });
                  return openStageLog(
                    { db, bus, storageRoot: storageRoot(), capBytes: settings.config.logCapBytes, after: started },
                    { videoId: stage.videoId, stageRunId: stage.id, stageName: stage.name, fence: claim.fence },
                  );
                },
                provider: { call: async () => { throw new Error("runtime requires a stage handler"); } },
              }, job).catch((err: unknown) => {
                try { log(`stage ${job.stageRunId} crashed: ${err instanceof Error ? err.name : "Error"}: ${redactLine(safeReason(err))}`); } catch { /* logging must never change the outcome */ }
                throw err;
              });
              // Breaker event and (for a clear provider rejection only) the retry row. Best-effort: if this fails the
              // sweep schedules the retry later, and a missed breaker event only delays the pause by one failure.
              let retryScheduled = false;
              if (outcome && "claim" in outcome) {
                try {
                  const follow = await hooks.afterOutcome(db, queue!, { kind: outcome.kind, stageRunId: outcome.claim.stageRunId }, readers);
                  // scheduled or held by the breaker: not news yet. The sweep tells the owner if it later gives up.
                  retryScheduled = follow.retry?.kind === "scheduled" || follow.retry?.kind === "held";
                  if (follow.breakerOpened) await notifyBreaker(db, follow.breakerOpened);
                } catch { log("retry bookkeeping failed"); }
              }
              const evType = outcome && "claim" in outcome ? OUTCOME_EVENTS[outcome.kind] : undefined;
              if (evType && "claim" in outcome) {
                try {
                  const row = await getStage(db, outcome.claim.stageRunId);
                  await emit({ type: evType, videoId: row?.videoId, stageRunId: outcome.claim.stageRunId, payload: { stage: row?.name, fence: outcome.claim.fence, outcome: outcome.kind } });
                } catch { log("event emit failed"); }
              }
              const hit = outcome && "claim" in outcome ? NOTIFY_OUTCOMES[outcome.kind] : undefined;
              // A failure that is being retried is not news yet: the owner hears when the retries run out.
              if (hit && "claim" in outcome && !retryScheduled) {
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
      const pause = Promise.allSettled([safely(() => consumer?.pause?.()), safely(() => uploadConsumer?.pause?.()), safely(() => ingestConsumer?.pause?.())]);
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
          safely(() => consumer?.close(true)), safely(() => uploadConsumer?.close(true)), safely(() => ingestConsumer?.close(true)), safely(() => queue?.close(true)), safely(() => uploadQueue?.close(true)), safely(() => ingestQueue?.close(true)), safely(() => bus?.close()), safely(async () => { await workerLock?.release(); await pool?.end(); }),
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
