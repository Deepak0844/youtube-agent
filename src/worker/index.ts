import { fileURLToPath } from "node:url";

export function startWorker(log: (message: string) => void = console.log) {
  log("worker started");
  // Keeps the event loop alive until stop(); queue consumers replace this in Phase 2.
  const keepAlive = setInterval(() => {}, 1 << 30);
  return {
    async stop() {
      clearInterval(keepAlive);
      log("worker stopped");
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const worker = startWorker();
  const shutdown = () => void worker.stop().then(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
