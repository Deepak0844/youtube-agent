// Child process for the engine resilience suite (Task 25). Run as `node --import tsx engine-worker.ts` (ONE process, so a
// SIGKILL really kills the worker and leaves nothing behind).
//
// It is the REAL worker runtime (src/worker/runtime.ts) with the dry-run handlers on fake providers, the real approval
// readers and the fake uploader. The only additions are test seams:
//   - every provider call is recorded in the independent fake_provider_calls table under the REAL call key, and in
//     engine_calls under the LOGICAL step (stage run id : step : tool), so a bug that mints a fresh key per attempt is still seen;
//   - a fault plan (JSON file, re-read at every seam so the harness can change it without a restart) can SIGKILL this process
//     at five exact points, or make a provider call hang.
//
// env: DATABASE_URL, REDIS_URL, STORAGE_ROOT, WORKER_ID, PLAN_FILE, INTERVAL_MS (reconcile loop, default 150).
// plan: { crash?: { stage, point: "a"|"b"|"c"|"d"|"e", nth? }, hang?: { stage, ms, nth? }, freshKey?: boolean }
//   a  before the paid call is reserved        d  after settle, before the stage commits
//   b  during the provider call (called, not returned)   e  after commit, before the worker moves the video on
//   c  after the provider returned, before settle
import { readFileSync } from "node:fs";
import type { PaidCallPorts } from "@/server/core/paid-call";
import { callKey } from "@/server/core/spend";
import { approvalReaders } from "@/server/db/approval-readers";
import { createPool } from "@/server/db/pool";
import { runStage } from "@/server/db/stage-runner-adapter";
import { createFakeUploader } from "@/server/providers/uploader/fake";
import { startWorker } from "@/worker";
import { defaultDryRunDeps, dryRunHandlers } from "@/worker/handlers";

interface Plan {
  crash?: { stage: string; point: "a" | "b" | "c" | "d" | "e"; nth?: number };
  hang?: { stage: string; ms: number; nth?: number };
  freshKey?: boolean;
}
const readPlan = (): Plan => {
  try { return JSON.parse(readFileSync(process.env.PLAN_FILE!, "utf8")) as Plan; } catch { return {}; }
};

const pool = createPool(process.env.DATABASE_URL!);
const root = process.env.STORAGE_ROOT!;
const seen = new Map<string, number>();
const hit = (stage: string, point: string): number => {
  const k = `${stage}:${point}`;
  const n = seen.get(k) ?? 0;
  seen.set(k, n + 1);
  return n;
};
const dieHere = (stage: string, point: "a" | "b" | "c" | "d" | "e") => {
  const c = readPlan().crash;
  if (!c || c.stage !== stage || c.point !== point) return;
  if (hit(stage, point) !== (c.nth ?? 0)) return;
  process.kill(process.pid, "SIGKILL");
};

const stageNames = new Map<string, string>();
const nameOf = async (id: string): Promise<string> => {
  let n = stageNames.get(id);
  if (!n) {
    n = (await pool.query<{ name: string }>("select name from stage_runs where id = $1", [id])).rows[0]?.name ?? "?";
    stageNames.set(id, n);
  }
  return n;
};
/** The intent a provider call belongs to: set when the reserve says "new", read by the provider wrapper of the same stage run. */
const current = new Map<string, { real: string; logical: string }>();
const byIntent = new Map<string, { stage: string }>();

function wrapPorts(base: PaidCallPorts): PaidCallPorts {
  return {
    ...base,
    async reserve(claim, args) {
      const stage = await nameOf(claim.stageRunId);
      dieHere(stage, "a");
      const logical = callKey(claim.stageRunId, args.stepIndex, args.toolCallIndex);
      // MUTATION (harness check only): a fresh step index for every attempt = a fresh call key for every attempt.
      const sent = readPlan().freshKey ? { ...args, stepIndex: args.stepIndex + 1000 * Number(claim.fence) } : args;
      const r = await base.reserve(claim, sent);
      if (r.kind === "new") {
        current.set(claim.stageRunId, { real: callKey(claim.stageRunId, sent.stepIndex, sent.toolCallIndex), logical });
        byIntent.set(r.intentId, { stage });
      }
      return r;
    },
    async settle(intentId, args) {
      const stage = byIntent.get(intentId)?.stage ?? "?";
      dieHere(stage, "c");
      await base.settle(intentId, args);
      dieHere(stage, "d");
    },
  };
}

async function onProviderCall(stageRunId: string, stage: string): Promise<void> {
  const k = current.get(stageRunId);
  if (!k) throw new Error("provider called without a reserved intent");
  await pool.query("insert into fake_provider_calls (call_key) values ($1)", [k.real]);
  await pool.query("insert into engine_calls (real_key, logical_key) values ($1, $2)", [k.real, k.logical]);
  dieHere(stage, "b");
  const h = readPlan().hang;
  if (h && h.stage === stage && hit(stage, "hang") === (h.nth ?? 0)) await new Promise((r) => setTimeout(r, h.ms));
}

const base = defaultDryRunDeps(pool, root);
const deps = {
  ...base,
  voice: { ...base.voice, synthesise: async (ctx: Parameters<typeof base.voice.synthesise>[0], a: Parameters<typeof base.voice.synthesise>[1]) => { await onProviderCall(ctx.claim.stageRunId, ctx.stage.name); return base.voice.synthesise(ctx, a); } },
  image: { ...base.image, generate: async (ctx: Parameters<typeof base.image.generate>[0], a: Parameters<typeof base.image.generate>[1]) => { await onProviderCall(ctx.claim.stageRunId, ctx.stage.name); return base.image.generate(ctx, a); } },
};

const worker = startWorker({
  workerId: process.env.WORKER_ID,
  pool,
  redisUrl: process.env.REDIS_URL,
  storageRoot: root,
  handlers: dryRunHandlers(deps),
  readers: approvalReaders,
  uploader: createFakeUploader({ pool }),
  intervalMs: Number(process.env.INTERVAL_MS ?? 150),
  retryMs: 300,
  shutdownTimeoutMs: 4000,
  log: () => {},
  hooks: {
    runStage: (db, d, job) => runStage(db, d, job, { paid: wrapPorts }),
    afterOutcome: async (db, queue, outcome, readers) => {
      if (outcome.kind === "committed") dieHere(await nameOf(outcome.stageRunId), "e");
      const { afterStageOutcome } = await import("@/server/db/retry");
      return afterStageOutcome(db, queue, outcome, readers);
    },
  },
});
void worker.ready.then(() => process.stdout.write("READY\n"));
process.on("SIGTERM", () => { void worker.stop().then(() => process.exit(0)); });
