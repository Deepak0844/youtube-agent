import { fileURLToPath } from "node:url";
import { createPool } from "@/server/db/pool";
import { defaultDryRunDeps, dryRunHandlers, productionHandlers } from "./handlers";
import { startRuntime, type WorkerOptions } from "./runtime";

// Retain startWorker(log) for existing callers, alongside the runtime options interface.
export function startWorker(opts: WorkerOptions | ((message: string) => void) = {}) {
  return startRuntime(typeof opts === "function" ? { log: opts } : opts);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const log = (line: string) => process.stdout.write(`${line}\n`);
  if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
    const missing = !process.env.DATABASE_URL ? "DATABASE_URL" : "REDIS_URL";
    process.stderr.write(`${missing} is not set; configure .env.local before starting the worker\n`);
    process.exitCode = 1;
  } else {
    const pool = createPool(process.env.DATABASE_URL);
    // Fake providers only on an explicit opt-in, never in production (there is no fake fallback).
    const dryRun = process.env.ENGINE_DRY_RUN === "1" && process.env.NODE_ENV !== "production";
    if (dryRun) log("ENGINE_DRY_RUN=1: stages run on fake providers");
    const worker = startWorker({ log, pool, handlers: dryRun ? dryRunHandlers(defaultDryRunDeps(pool)) : productionHandlers(pool) });
    let exiting = false;
    const shutdown = () => {
      if (exiting) return;
      exiting = true;
      void worker.stop().then(() => process.exit(0), () => process.exit(1));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    void worker.ready.catch(async () => { await worker.stop(); process.exitCode = 1; });
  }
}
