// Local dry run (Phase 2 Task 20): makes ONE fake video end to end on fake providers and prints the path of the file.
//
//   ENGINE_DRY_RUN=1 npm run dry-run -- ["a topic"] [--auto-approve]
//
// Needs a migrated local database (DATABASE_URL, the app role) and ffprobe/ffmpeg. No network, no real key, no real money:
// every stage is the dry-run handler (src/worker/handlers.ts) and the only "model" is a scripted one.
//
// The owner's gates are NOT skipped by default: the script runs until the video waits at a gate, prints which one, and stops.
// `--auto-approve` is for a throwaway local database only: it signs gates with a made-up session id (the audit log shows
// it), so it is refused in production and whenever ENGINE_DRY_RUN is not "1". It is not an owner action.
import { randomUUID } from "node:crypto";
import path from "node:path";
import type pg from "pg";
import { createStageDispatcher, dryRunHandlers, defaultDryRunDeps } from "@/worker/handlers";
import { buildEngineConfig } from "@/server/core/engine-config";
import { IMPLEMENTED_GATES } from "@/server/core/approvals";
import type { GateId } from "@/server/core/gates";
import { approvalState, approveGate, liveGateHash } from "@/server/db/approvals";
import { pendingScriptFeedback } from "@/server/db/draft-store";
import { getEngineConfig } from "@/server/db/engine-config";
import { getPool } from "@/server/db/pool";
import { advanceVideo, createVideo, type PipelineReaders } from "@/server/db/pipeline";
import { runStage } from "@/server/db/stage-runner-adapter";
import { latestContent } from "@/server/db/videos";
import { storageRoot } from "@/server/storage/paths";

const readers: PipelineReaders = {
  approvedGates: async (c, videoId) => {
    const out = new Set<GateId>();
    for (const g of IMPLEMENTED_GATES) if ((await approvalState(c, videoId, g)).approved) out.add(g);
    return out;
  },
  feedback: (c, videoId) => pendingScriptFeedback(c as unknown as pg.Pool, videoId),
};

async function main(): Promise<void> {
  const autoApprove = process.argv.includes("--auto-approve");
  if (process.env.ENGINE_DRY_RUN !== "1") throw new Error("Set ENGINE_DRY_RUN=1. This tool makes fake videos and must never run by accident.");
  if (process.env.NODE_ENV === "production") throw new Error("The dry run is refused in production.");
  const topic = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "Why do octopuses have three hearts?";

  const db = getPool();
  const root = storageRoot();
  const deps = defaultDryRunDeps(db, root);
  const dispatcher = createStageDispatcher(dryRunHandlers(deps), 1);
  const config = await getEngineConfig(db).catch(() => buildEngineConfig(new Map()));
  const video = await createVideo(db, { format: "short", kind: "scene_kit", language: "en", topic });
  process.stdout.write(`video ${video.id}\n`);

  const pending: Array<{ id: string; inputHash: string }> = [];
  const queue = { enqueue: async (id: string, _fence: number, _seq: number, inputHash: string) => (pending.push({ id, inputHash }), id) };
  const actor = { kind: "session", sessionId: randomUUID() } as const;

  for (let guard = 0; guard < 40; guard++) {
    // QA saves the video file; that is the product of the dry run. The owner's video, evidence and publish gates come after it.
    const made = await latestContent(db, video.id, "video");
    if (made?.filePath) {
      process.stdout.write(`${path.join(root, made.filePath)}\n`);
      return;
    }
    const step = await advanceVideo(db, queue, video.id, readers);
    const job = pending.shift();
    if (job) {
      const outcome = await runStage(db, { provider: { call: async () => Promise.reject(new Error("no provider")) }, ttlMs: 60_000, workerId: "dry-run", handler: dispatcher, config }, { stageRunId: job.id, inputHash: job.inputHash });
      process.stdout.write(`stage ${job.id.slice(0, 8)}: ${outcome.kind}\n`);
      if (outcome.kind !== "committed") throw new Error(`The dry run stopped: a stage ended ${outcome.kind}.`);
      continue;
    }
    const action = step.action;
    if (action?.kind === "wait_gate") {
      if (!autoApprove) {
        process.stdout.write(`Waiting for you at the ${action.gate} gate. Nothing was approved. Re-run with --auto-approve on a throwaway database to skip the owner.\n`);
        return;
      }
      const live = await liveGateHash(db, video.id, action.gate);
      if (!live) throw new Error(`The ${action.gate} gate has nothing to approve yet.`);
      const r = await approveGate(db, { videoId: video.id, gate: action.gate, seenHash: live.hash, actor });
      if (!r.ok) throw new Error(r.reason);
      process.stdout.write(`approved ${action.gate} (dry run, made-up session)\n`);
      continue;
    }
    if (action?.kind === "done") throw new Error("The video is done but no video file is recorded.");
    if (action?.kind === "wait_stage") throw new Error(`Stage ${action.stage} is ${action.status}; the dry run cannot continue.`);
  }
  throw new Error("The dry run did not finish in 40 steps.");
}

main().then(
  async () => { await getPool().end(); },
  async (e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
    await getPool().end().catch(() => undefined);
  },
);
