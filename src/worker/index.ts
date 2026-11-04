import { fileURLToPath } from "node:url";
import { createPool } from "@/server/db/pool";
import { advanceAll } from "@/server/db/pipeline";
import { autoSeoSweep } from "@/server/db/seo";
import { approvalReaders } from "@/server/db/approval-readers";
import { dryRunRefusal } from "./stages/guard";
import type { ChildRegistry } from "@/server/render/child";
import { defaultDryRunDeps, dryRunHandlers, productionHandlers, workerHooksFor, type StageHandlers } from "./handlers";
import { loadKeyring } from "@/server/db/master-key";
import { createFakeUploader } from "@/server/providers/uploader/fake";
import { createYouTubeUploader } from "@/server/providers/uploader/youtube";
import { throttledRetention } from "@/server/db/retention";
import { storageRoot } from "@/server/storage/paths";
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
      let handlers: StageHandlers | ((env: { childRegistry: ChildRegistry; workerId: string }) => StageHandlers) = (env) => productionHandlers(pool, env);
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
      const hooks = workerHooksFor(pool, process.env);
      // First metadata draft after render: only the real worker does it (a dry run has no model), and tests that boot the
      // runtime directly never do, so their stage counts stay as they are.
      if (process.env.ENGINE_DRY_RUN !== "1") {
        // Asset retention: at most once every 6 h, in the background (it never throws and never blocks the loop).
        const retentionTick = throttledRetention(pool, storageRoot());
        hooks.advanceAll = async (p, queue, readers) => {
          const r = await advanceAll(p, queue, readers);
          await autoSeoSweep(p, queue).catch(() => undefined);
          void retentionTick();
          return r;
        };
      }
      // Approved uploads: the fake only in a guarded dry run. Otherwise the real YouTube uploader, which still sends nothing unless the
      // job-time checks pass (kill switch off, channel connected and confirmed, approval and file hash intact).
      const uploader = process.env.ENGINE_DRY_RUN === "1" ? createFakeUploader({ pool }) : createYouTubeUploader({ pool, ring: loadKeyring });
      const worker = startWorker({ log, pool, handlers, readers: approvalReaders, ingest: true, hooks, uploader });
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
  