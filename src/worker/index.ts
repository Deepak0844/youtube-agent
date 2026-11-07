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
import { throttledCommentSync } from "@/server/db/comments";
import { pullAnalytics, pullMessage } from "@/server/db/analytics";
import { runCompetitorsJob, throttledResearchPurge } from "@/server/db/research";
import { runOptimizer, runWeeklyReview } from "@/server/db/insights";
import { runIdeaResearch } from "@/server/db/idea-research";
import { createInsightsModel } from "@/server/db/insights-model";
import { defaultModelDeps } from "@/server/llm/default-deps";
import { runOvernightDrafting } from "@/server/db/drafting";
import { throttledScheduler } from "@/server/db/scheduler";
import { checkTargetPause } from "@/server/db/targets";
import { defaultGoogleHttp } from "@/server/db/youtube-channels";
import { throttledRetention } from "@/server/db/retention";
import { storageRoot } from "@/server/storage/paths";
import { startRuntime, type WorkerOptions } from "./runtime";

// Retain startWorker(log) for existing callers, alongside the runtime options interface.
export function startWorker(opts: WorkerOptions | ((message: string) => void) = {}) {
  return startRuntime(typeof opts === "function" ? { log: opts } : opts);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const log = (line: string) => process.stdout.write(`${line}\n`);
  const insightsModel = (p: ReturnType<typeof createPool>) => createInsightsModel(p, () => defaultModelDeps(p, () => loadKeyring()));
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
        // Comment sync: read only, at most once every 6 h; drafts it queues wait held for the owner. Posting is never done here.
        let syncTick: (() => Promise<void>) | undefined;
        // Scheduler (Phase 6): daily analytics pull (read only). Other jobs join as their pieces land.
        let scheduleTick: (() => Promise<void>) | undefined;
        let purgeTick: (() => Promise<void>) | undefined;
        hooks.advanceAll = async (p, queue, readers, send) => {
          const r = await advanceAll(p, queue, readers, { send });
          await autoSeoSweep(p, queue).catch(() => undefined);
          void retentionTick();
          syncTick ??= throttledCommentSync(p, loadKeyring, defaultGoogleHttp, queue);
          void syncTick();
          scheduleTick ??= throttledScheduler(
            p,
            {
              // Overnight drafting: starts normal drafts only (capped, one at a time); never approves, uploads or publishes.
              drafting: () => runOvernightDrafting(p, queue),
              analytics: async () => {
                const message = pullMessage(await pullAnalytics(p, loadKeyring, defaultGoogleHttp, { kind: "worker" }));
                await checkTargetPause(p, send); // fresh numbers: may switch overnight drafting off, once
                return message;
              },
              // One paid text call per job and period through the paid-call path; with no priced "Titles and insights" model it
              // skips quietly (numbers only for the review).
              weekly_review: async () => (await runWeeklyReview(p, insightsModel(p), { kind: "worker" }, { send })).message,
              optimizer: async () => (await runOptimizer(p, insightsModel(p), { kind: "worker" })).message,
              // Idea researcher: one capped model call over our own data, nothing fetched; adds proposed ideas only. Skips quietly with no
              // priced "Titles and insights" model or at a spend limit.
              research: async () => (await runIdeaResearch(p, insightsModel(p), { kind: "worker" })).message,
              // Research (read only): competitor stats and trend lists, quota guarded; also deletes research rows older than 30 days.
              competitors: () => runCompetitorsJob(p, loadKeyring, defaultGoogleHttp),
            },
            send,
          );
          void scheduleTick();
          purgeTick ??= throttledResearchPurge(p);
          void purgeTick();
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
  