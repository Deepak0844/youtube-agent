// The dev:all concurrently supervisor restarts an exited worker. The integration test acts as that supervisor:
// kill this single Node process, then start its replacement against the same database and Redis queue.
import { startWorker } from "@/worker";
import { createJobQueue } from "@/server/queue/job-queue";

const worker = startWorker({
  workerId: process.env.WORKER_ID,
  hooks: { connectQueue: async () => createJobQueue(process.env.REDIS_URL!, "stages", process.env.QUEUE_SUFFIX!) },
  handlers: {
    draft: async () => {
      process.stdout.write("HANDLER_STARTED\n");
      if (process.env.BLOCK_HANDLER === "1") await new Promise(() => {});
      return { replacement: true };
    },
  },
});
void worker.ready.then(() => process.stdout.write("READY\n"));
process.on("SIGTERM", () => { void worker.stop().then(() => process.exit(0)); });
