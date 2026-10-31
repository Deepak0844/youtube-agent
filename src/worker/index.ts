import { fileURLToPath } from "node:url";
import { createPool } from "@/server/db/pool";
import { approvalReaders } from "@/server/db/approval-readers";
import { dryRunRefusal } from "./stages/guard";
import type { ChildRegistry } from "@/server/render/child";
import { defaultDryRunDeps, dryRunHandlers, productionHandlers, type StageHandlers } from "./handlers";
import { sweepRenderContainers } from "@/server/providers/renderer/remotion-container";
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
    void (async () => {
      // Fake providers only on an explicit opt-in that passes the guard; a refused opt-in stops the worker (no silent fallback).
      let handlers: StageHandlers | ((env: { childRegistry: ChildRegistry }) => StageHandlers) = ({ childRegistry }) => productionHandlers(pool, { childRegistry });
      if (process.env.ENGINE_DRY_RUN === "1") {
        const refusal = await dryRunRefusal(pool, process.env).catch((e: unknown) => `The dry run guard could not check the database (${e instanceof Error ? e.message : "error"}).`);
        if (refusal) {
          process.stderr.write(`${refusal}\n`);
          process.exitCode = 1;
          await pool.end().catch(() => undefined);
          return;
        }
        log("ENGINE_DRY_RUN=1: stages run on fake providers");
        handlers = dryRunHandlers(defaultDryRunDeps(pool));
      }
      // The real worker (not the dry run) also removes render containers a dead worker left behind, once it holds the lock.
      const hooks = process.env.ENGINE_DRY_RUN === "1" ? {} : { sweepRenderContainers: () => sweepRenderContainers() };
      const worker = startWorker({ log, pool, handlers, readers: approvalReaders, ingest: true, hooks });
      let exiting = false;
      const shutdown = () => {
        if (exiting) return;
        exiting = true;
        void worker.stop().then(() => process.exit(0), () => process.exit(1));
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      void worker.ready.catch(async () => { await worker.stop(); process.exitCode = 1; });
    })();
  }
}
  