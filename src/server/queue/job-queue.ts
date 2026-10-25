import { Queue, Worker, type JobType, type WorkerOptions } from "bullmq";
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

export interface JobQueue {
  readonly name: string;
  enqueue(stageRunId: string, fence: number, attemptSeq: number, inputHash: string): Promise<string>;
  // One-shot upload job: job id upload.<uploadId> (one per upload row), attempts: 1, bounded removeOnFail.
  enqueueUpload(uploadId: string): Promise<string>;
  startWorker(
    handler: (job: StageJob, jobId: string) => Promise<void>,
    opts?: {
      concurrency?: number;
      onError?: (err: Error) => void;
      // Test knobs only (lock/stall timing). maxStalledCount is always forced to 0.
      bullmq?: Pick<WorkerOptions, "lockDuration" | "stalledInterval" | "skipLockRenewal">;
    },
  ): { close(): Promise<void> };
  // Ids of jobs that may still be delivered or are being processed (not completed/failed). One atomic Redis script.
  liveJobIds(): Promise<Set<string>>;
  close(): Promise<void>;
}

const LIVE: JobType[] = ["waiting", "active", "delayed", "prioritized", "waiting-children"];

export const DEFAULT_KEEP_FAILED = 1000;

export function createJobQueue(redisUrl: string, name: string, opts: { keepFailed?: number } = {}): JobQueue {
  const keepFailed = opts.keepFailed ?? DEFAULT_KEEP_FAILED;
  const connection = { url: redisUrl, maxRetriesPerRequest: null };
  const queue = new Queue(name, { connection });
  const workers = new Set<Worker>();

  return {
    name,
    async enqueue(stageRunId, fence, attemptSeq, inputHash) {
      const jobId = stageJobId(stageRunId, fence, attemptSeq);
      const data: StageJob = { stageRunId, inputHash };
      await queue.add("stage", data, { jobId, attempts: 1, removeOnComplete: true, removeOnFail: { count: keepFailed } });
      return jobId;
    },
    async enqueueUpload(uploadId) {
      if (!/^[0-9a-f-]{36}$/i.test(uploadId)) throw new RangeError(`invalid upload id: ${uploadId}`);
      const jobId = `upload.${uploadId}`;
      await queue.add("upload", { uploadId }, { jobId, attempts: 1, removeOnComplete: true, removeOnFail: { count: keepFailed } });
      return jobId;
    },
    startWorker(handler, opts = {}) {
      const worker = new Worker(
        name,
        async (job) => {
          if (job.name !== "stage") throw new Error(`unsupported job kind: ${job.name}`); // upload jobs have their own handler
          const data = job.data as StageJob;
          await handler({ stageRunId: data.stageRunId, inputHash: data.inputHash }, job.id!);
        },
        { ...opts.bullmq, connection, concurrency: opts.concurrency ?? 1, maxStalledCount: 0 },
      );
      const onError = opts.onError ?? ((err: Error) => console.error(`queue ${name} worker error:`, err));
      worker.on("error", onError);
      workers.add(worker);
      return {
        async close() {
          workers.delete(worker);
          await worker.close();
        },
      };
    },
    async liveJobIds() {
      return new Set(await queue.getRanges(LIVE, 0, -1));
    },
    async close() {
      await Promise.all([...workers].map((w) => w.close()));
      workers.clear();
      await queue.close();
    },
  };
}
