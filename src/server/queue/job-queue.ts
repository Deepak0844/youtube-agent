import { Queue, Worker, type Job, type JobType, type WorkerOptions } from "bullmq";
import { stageJobId } from "@/server/core/job-id";
import type { StageJob } from "@/server/core/stage-runner";

// BullMQ wrapper. Redis is DISPOSABLE: Postgres decides what runs (fenced claim), Redis only delivers. A lost,
// duplicated or stale job is harmless: the claim matches nothing and the handler is a no-op; the reconciler
// re-enqueues queued rows that have no live job.
//
// - Job id = stageJobId(stageRunId, fence, attemptSeq) = stage.<id>.<fence>.<attempt>: unique per attempt, because
//   BullMQ silently ignores add() for an id it already holds (failed jobs are kept, bounded to the newest keepFailed).
// - Payload { stageRunId, inputHash }: the row's input_hash AT ENQUEUE TIME; the claim uses it, so a job queued for
//   an older input never runs.
// - The reconciler is the ONLY retry authority, decided against Postgres: attempts: 1 (no BullMQ retries) and
//   maxStalledCount: 0. In BullMQ 6.4.2 a job whose lock expired is moved back to wait flagged with a deferred
//   failure (moveStalledJobsToWait-9.lua) and the next worker to fetch it fails it WITHOUT running the processor
//   (Worker.getUnrecoverableErrorMessage); a still-queued row is then re-enqueued by the reconciler under a new id.

export type QueueKind = "stages" | "uploads";

// Stage jobs and upload jobs never share a queue (BullMQ workers take any job on their queue): the kind fixes the
// real queue name (`stages` / `uploads`, plus `-<suffix>` in tests), the handler type and the enqueue method.
export interface StageQueue {
  readonly kind: "stages";
  readonly name: string;
  // delayMs holds the job back in Redis (a retry waiting out its back-off); Postgres not_before is the real gate.
  enqueue(stageRunId: string, fence: number, attemptSeq: number, inputHash: string, opts?: { delayMs?: number }): Promise<string>;
  startWorker(
    handler: (job: StageJob, jobId: string) => Promise<void>,
    opts?: {
      concurrency?: number;
      onError?: (err: Error) => void;
      // Test knobs only (lock/stall timing). maxStalledCount is always forced to 0.
      bullmq?: Pick<WorkerOptions, "lockDuration" | "stalledInterval" | "skipLockRenewal">;
    },
  ): { close(force?: boolean): Promise<void>; pause?(): Promise<void> };
  // Ids of jobs that may still be delivered or are being processed (not completed/failed). One atomic Redis script.
  liveJobIds(): Promise<Set<string>>;
  close(force?: boolean): Promise<void>;
  disconnect?(): Promise<void>;
}
export type JobQueue = StageQueue;

export interface UploadQueue {
  readonly kind: "uploads";
  readonly name: string;
  // One-shot upload job: job id upload.<uploadId> (one per upload row), attempts: 1, bounded removeOnFail.
  enqueueUpload(uploadId: string): Promise<string>;
  startWorker(
    handler: (uploadId: string, jobId: string) => Promise<void>,
    opts?: { concurrency?: number; onError?: (err: Error) => void },
  ): { close(force?: boolean): Promise<void>; pause?(): Promise<void> };
  close(force?: boolean): Promise<void>;
  disconnect?(): Promise<void>;
}

const LIVE: JobType[] = ["waiting", "active", "delayed", "prioritized", "waiting-children"];

export const DEFAULT_KEEP_FAILED = 1000;

const SUFFIX = /^[a-z0-9-]{1,40}$/;

export function createJobQueue(redisUrl: string, kind: "stages", suffix?: string, opts?: { keepFailed?: number; onError?: (err: Error) => void }): StageQueue;
export function createJobQueue(redisUrl: string, kind: "uploads", suffix?: string, opts?: { keepFailed?: number; onError?: (err: Error) => void }): UploadQueue;
export function createJobQueue(redisUrl: string, kind: QueueKind, suffix?: string, opts: { keepFailed?: number; onError?: (err: Error) => void } = {}): StageQueue | UploadQueue {
  if (kind !== "stages" && kind !== "uploads") throw new RangeError(`unknown queue kind: ${String(kind)}`);
  if (suffix !== undefined && !SUFFIX.test(suffix)) throw new RangeError(`invalid queue suffix: ${String(suffix)}`);
  const name = suffix === undefined ? kind : `${kind}-${suffix}`;
  const keepFailed = opts.keepFailed ?? DEFAULT_KEEP_FAILED;
  const connection = { url: redisUrl, maxRetriesPerRequest: null, enableOfflineQueue: false, connectTimeout: 1000 };
  const queue = new Queue(name, { connection });
  queue.on("error", opts.onError ?? (() => {}));
  const workers = new Set<Worker>();
  const wrong = (what: string): never => {
    throw new Error(`${what} is not available on a '${kind}' queue (${name})`);
  };

  function makeWorker(
    processor: (job: Job) => Promise<void>,
    opts: { concurrency?: number; onError?: (err: Error) => void; bullmq?: Pick<WorkerOptions, "lockDuration" | "stalledInterval" | "skipLockRenewal"> },
  ): { close(force?: boolean): Promise<void>; pause(): Promise<void> } {
    const worker = new Worker(name, processor, { ...opts.bullmq, connection, concurrency: opts.concurrency ?? 1, maxStalledCount: 0 });
    worker.on("error", opts.onError ?? ((err: Error) => console.error(`queue ${name} worker error:`, err)));
    workers.add(worker);
    return {
      pause: () => worker.pause(true),
      async close(force = false) {
        await worker.close(force);
        workers.delete(worker);
      },
    };
  }

  const disconnect = async () => { await Promise.allSettled([...workers].map((w) => w.disconnect()).concat(queue.disconnect())); };

  const close = async (force = false) => {
    await Promise.all([...workers].map((w) => w.close(force)));
    workers.clear();
    await queue.close();
  };

  if (kind === "stages") {
    const q: StageQueue & { enqueueUpload?: unknown } = {
      kind,
      name,
      async enqueue(stageRunId, fence, attemptSeq, inputHash, enqueueOpts) {
        const jobId = stageJobId(stageRunId, fence, attemptSeq);
        const data: StageJob = { stageRunId, inputHash };
        const delay = enqueueOpts?.delayMs;
        if (delay !== undefined && (!Number.isSafeInteger(delay) || delay < 0)) throw new RangeError("delayMs must be a non-negative integer");
        await queue.add("stage", data, { jobId, attempts: 1, removeOnComplete: true, removeOnFail: { count: keepFailed }, ...(delay ? { delay } : {}) });
        return jobId;
      },
      startWorker(handler, opts = {}) {
        return makeWorker(async (job) => {
          if (job.name !== "stage") throw new Error(`unsupported job kind: ${job.name}`);
          const data = job.data as StageJob;
          await handler({ stageRunId: data.stageRunId, inputHash: data.inputHash }, job.id!);
        }, opts);
      },
      async liveJobIds() {
        return new Set(await queue.getRanges(LIVE, 0, -1));
      },
      close, disconnect,
    };
    q.enqueueUpload = () => wrong("enqueueUpload");
    return q;
  }

  const u: UploadQueue & { enqueue?: unknown; liveJobIds?: unknown } = {
    kind,
    name,
    async enqueueUpload(uploadId) {
      if (!/^[0-9a-f-]{36}$/i.test(uploadId)) throw new RangeError(`invalid upload id: ${uploadId}`);
      const jobId = `upload.${uploadId}`;
      await queue.add("upload", { uploadId }, { jobId, attempts: 1, removeOnComplete: true, removeOnFail: { count: keepFailed } });
      return jobId;
    },
    startWorker(handler, opts = {}) {
      return makeWorker(async (job) => {
        if (job.name !== "upload") throw new Error(`unsupported job kind: ${job.name}`);
        await handler((job.data as { uploadId: string }).uploadId, job.id!);
      }, opts);
    },
    close, disconnect,
  };
  u.enqueue = () => wrong("enqueue");
  u.liveJobIds = () => wrong("liveJobIds");
  return u;
}
