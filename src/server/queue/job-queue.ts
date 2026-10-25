import { Queue, Worker, type JobType } from "bullmq";
import { stageJobId } from "@/server/core/job-id";
import type { StageJob } from "@/server/core/stage-runner";

// BullMQ wrapper. Redis is DISPOSABLE: Postgres decides what runs (fenced claim), Redis only delivers. A lost,
// duplicated or stale job is harmless: the claim matches nothing and the handler is a no-op; the reconciler
// re-enqueues queued rows that have no live job.
//
// - Job id = stageJobId(stageRunId, fence, attemptSeq) = stage.<id>.<fence>.<attempt>: unique per attempt, because
//   BullMQ silently ignores add() for an id it already holds (failed jobs are kept: removeOnFail: false).
// - Payload { stageRunId, inputHash }: the row's input_hash AT ENQUEUE TIME; the claim uses it, so a job queued for
//   an older input never runs.
// - attempts: 1 (no BullMQ retries: retrying is the reconciler's decision, made against Postgres).

export interface JobQueue {
  readonly name: string;
  enqueue(stageRunId: string, fence: number, attemptSeq: number, inputHash: string): Promise<string>;
  startWorker(
    handler: (job: StageJob, jobId: string) => Promise<void>,
    opts?: { concurrency?: number; onError?: (err: Error) => void },
  ): { close(): Promise<void> };
  // Ids of jobs that may still be delivered or are being processed (not completed/failed). One atomic Redis script.
  liveJobIds(): Promise<Set<string>>;
  close(): Promise<void>;
}

const LIVE: JobType[] = ["waiting", "active", "delayed", "prioritized", "waiting-children"];

export function createJobQueue(redisUrl: string, name: string): JobQueue {
  const connection = { url: redisUrl, maxRetriesPerRequest: null };
  const queue = new Queue(name, { connection });
  const workers = new Set<Worker>();

  return {
    name,
    async enqueue(stageRunId, fence, attemptSeq, inputHash) {
      const jobId = stageJobId(stageRunId, fence, attemptSeq);
      const data: StageJob = { stageRunId, inputHash };
      await queue.add("stage", data, { jobId, attempts: 1, removeOnComplete: true, removeOnFail: false });
      return jobId;
    },
    startWorker(handler, opts = {}) {
      const worker = new Worker(
        name,
        async (job) => {
          const data = job.data as StageJob;
          await handler({ stageRunId: data.stageRunId, inputHash: data.inputHash }, job.id!);
        },
        { connection, concurrency: opts.concurrency ?? 1 },
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
