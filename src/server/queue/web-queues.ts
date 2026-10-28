import type { EnqueueOnly } from "@/server/db/pipeline";
import { createJobQueue, type StageQueue, type UploadQueue } from "@/server/queue/job-queue";

// The web process only ever ADDS jobs (the worker consumes them). One queue object per kind per process, created on first
// use so `next build` and pages that never act do not touch Redis. Redis is disposable: when it is down or not configured the
// add fails, the row stays queued/approved in Postgres, and the worker's sweep or the "Send again" button delivers it.
const KEY = Symbol.for("ytstudio.web-queues");
type Held = { stage?: StageQueue; upload?: UploadQueue };
const held = (): Held => ((globalThis as unknown as Record<symbol, Held>)[KEY] ??= {});

const down = (): Promise<never> => Promise.reject(new Error("redis is not configured"));

export function webStageQueue(): EnqueueOnly {
  const url = process.env.REDIS_URL;
  if (!url) return { enqueue: down };
  const h = held();
  return (h.stage ??= createJobQueue(url, "stages"));
}

export function webUploadQueue(): Pick<UploadQueue, "enqueueUpload"> {
  const url = process.env.REDIS_URL;
  if (!url) return { enqueueUpload: down };
  const h = held();
  return (h.upload ??= createJobQueue(url, "uploads"));
}
