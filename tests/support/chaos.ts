import { Redis } from "ioredis";
import type pg from "pg";
import type { PaidCallPorts } from "@/server/core/paid-call";
import { uuidv7 } from "@/server/core/ids";
import { callKey } from "@/server/core/spend";
import type { StageJob, StageStep } from "@/server/core/stage-runner";
import { reconcile } from "@/server/db/reconciler";
import { runStage } from "@/server/db/stage-runner-adapter";
import { insertQueuedStage } from "@/server/db/stages";
import { handleUploadJob, runUpload, type UploadJobDeps } from "@/server/db/upload-job";
import { finishUpload, markStalled, type StartCtx } from "@/server/db/uploads";
import { createJobQueue } from "@/server/queue/job-queue";
import { spawnChildWorker, waitFor } from "../integration/helpers/stage-env";
import type { TestDb } from "./db";
import { createFakeProvider, hangs, knownFailure, ok, type Outcome } from "./fake-provider";

// Chaos harness for exactly-once execution. A seeded PRNG fixes the PLAN of faults (planFor is a pure function of the
// seed); the interleavings are real (Promise.all, real Postgres, real Redis, real BullMQ) and not deterministic, so
// the invariants must hold for ALL interleavings. Replay a failing seed with CHAOS_SEED_ONLY=<n>.

export type BrokenMode = "broken_call_key" | "broken_requeue" | "broken_upload_door";

export type CrashPoint = "after_claim" | "after_reserve" | "after_provider" | "after_settle" | "before_commit";
export interface CrashSpec {
  point: CrashPoint;
  step: number;
}
export interface StagePlan {
  delayMs: number[];
  actual: number[];
  knownFailStep: number; // -1 = none
  crashes: CrashSpec[]; // by attempt ordinal (first claim, second claim, ...)
  dropBeforeClaim: number; // first K queue deliveries are lost before claiming
  extraDeliveries: number;
  directDups: number; // concurrent direct handler calls
  directDupAtMs: number;
}
export type UploadBehavior = "ok" | "fail" | "hang" | "late_success" | "slow_stall";
export interface UploadPlan {
  behavior: UploadBehavior;
  video: number;
  dupStarts: number;
  dupDelaysMs: number[];
  staleReportAtMs: number; // -1 = none
}
export type ChaosEvent =
  | { atMs: number; kind: "flush" }
  | { atMs: number; kind: "reconcile"; double: boolean }
  | { atMs: number; kind: "mark_stalled" }
  | { atMs: number; kind: "expire_lease"; stage: number };
export interface ChaosPlan {
  seed: number;
  capG: number;
  stages: StagePlan[];
  uploads: UploadPlan[];
  events: ChaosEvent[];
  realKill: { marker: "CLAIMED" | "INTENT_RESERVED" | "PROVIDER_RETURNED" | "SETTLED" } | null;
}
export interface Shape {
  stages: number;
  uploads: number;
  steps: number;
}
export const DEFAULT_SHAPE: Shape = { stages: 5, uploads: 3, steps: 3 };

export interface ChaosResult {
  seed: number;
  providerCallsByKey: Map<string, number>;
  uploaderStartsByUploadId: Map<string, number>;
  finalStageStatuses: Record<string, string>;
  finalUploadStatuses: Record<string, string>;
  budgetConsistent: boolean;
  violations: string[];
}

export class CrashSignal extends Error {
  constructor(where: string) {
    super(`chaos crash: ${where}`);
    this.name = "CrashSignal";
  }
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function planFor(seed: number, shape: Shape = DEFAULT_SHAPE): ChaosPlan {
  const rnd = mulberry32(seed * 7919 + 13);
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const chance = (p: number) => rnd() < p;
  const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)]!;
  const POINTS: CrashPoint[] = ["after_claim", "after_reserve", "after_provider", "after_settle", "before_commit"];

  const realKill = seed % 25 === 0 ? { marker: pick(["CLAIMED", "INTENT_RESERVED", "PROVIDER_RETURNED", "SETTLED"] as const) } : null;
  const capG = realKill || chance(0.7) ? 1_000_000_000 : int(4000, 14000);

  const stages: StagePlan[] = [];
  for (let i = 0; i < shape.stages; i++) {
    const crashes: CrashSpec[] = [];
    let p = 0.6;
    while (crashes.length < 3 && chance(p)) {
      let point = pick(POINTS);
      if (point === "after_settle" && shape.steps < 2) point = "before_commit";
      const step = point === "before_commit" ? shape.steps - 1 : point === "after_settle" ? int(0, shape.steps - 2) : int(0, shape.steps - 1);
      crashes.push({ point, step });
      p *= 0.5;
    }
    stages.push({
      delayMs: Array.from({ length: shape.steps }, () => (chance(0.2) ? int(60, 160) : int(0, 25))),
      actual: Array.from({ length: shape.steps }, () => int(400, 1000)),
      knownFailStep: chance(0.15) ? int(0, shape.steps - 1) : -1,
      crashes,
      dropBeforeClaim: chance(0.2) ? int(1, 2) : 0,
      extraDeliveries: int(0, 2),
      directDups: chance(0.4) ? int(1, 3) : 0,
      directDupAtMs: int(0, 150),
    });
  }

  const uploads: UploadPlan[] = [];
  for (let i = 0; i < shape.uploads; i++) {
    const dupStarts = int(1, 4);
    uploads.push({
      behavior: pick(["ok", "ok", "ok", "fail", "hang", "late_success", "slow_stall"] as const),
      video: i === 2 && chance(0.35) ? 0 : i,
      dupStarts,
      dupDelaysMs: Array.from({ length: dupStarts }, (_, k) => (k === 0 ? 0 : chance(0.4) ? 0 : int(20, 300))),
      staleReportAtMs: chance(0.5) ? int(0, 250) : -1,
    });
  }

  const events: ChaosEvent[] = [];
  for (let k = int(0, 2); k > 0; k--) events.push({ atMs: int(30, 350), kind: "flush" });
  for (let k = int(3, 6); k > 0; k--) events.push({ atMs: int(0, 450), kind: "reconcile", double: chance(0.3) });
  for (let k = int(0, 3); k > 0; k--) events.push({ atMs: int(20, 300), kind: "expire_lease", stage: int(0, shape.stages - 1) });
  for (let k = int(1, 3); k > 0; k--) events.push({ atMs: int(50, 450), kind: "mark_stalled" });
  events.sort((a, b) => a.atMs - b.atMs);
  return { seed, capG, stages, uploads, events, realKill };
}

// ---- runtime ----------------------------------------------------------------------------------------------------

const TTL_MS = 250;
const GRACE_MS = 50;
const STALL_MS = 200;
const HASH = "chaos-h";
const CAPS = { maxPerDay: 20, minSpacingMs: 0, dailyQuotaUnits: 1_000_000, costUnits: 1 };
const TERMINAL = new Set(["succeeded", "failed", "needs_decision", "cancelled"]);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let runCounter = 0;
let nonce = 1_000_000;
const probed = new WeakSet<pg.Pool>();

// Test-only probes: log every status transition so "a parked stage is never requeued" is checked exactly.
async function installProbes(pool: pg.Pool): Promise<void> {
  if (probed.has(pool)) return;
  await pool.query(
    "create table if not exists chaos_transitions (seq bigserial primary key, kind text not null, row_id uuid not null, old_status text, new_status text)",
  );
  await pool.query(`create or replace function chaos_log_transition() returns trigger language plpgsql as $$
    begin
      if old.status is distinct from new.status then
        insert into chaos_transitions (kind, row_id, old_status, new_status) values (tg_argv[0], new.id, old.status, new.status);
      end if;
      return new;
    end $$`);
  await pool.query("drop trigger if exists chaos_stage_t on stage_runs");
  await pool.query("create trigger chaos_stage_t after update on stage_runs for each row execute function chaos_log_transition('stage')");
  await pool.query("drop trigger if exists chaos_upload_t on uploads");
  await pool.query("create trigger chaos_upload_t after update on uploads for each row execute function chaos_log_transition('upload')");
  probed.add(pool);
}

// Mimics an unconditional reconciler: requeues expired running stages AND parked ones, ignoring open intents.
async function brokenReconcile(pool: pg.Pool, enqueue: (id: string, fence: number, seq: number, hash: string) => Promise<unknown>): Promise<void> {
  const { rows } = await pool.query<{ id: string; fence: string; attempt_seq: number; input_hash: string }>(
    `update stage_runs
        set status = 'queued', lease_owner = null, lease_until = null, attempt_seq = attempt_seq + 1, updated_at = clock_timestamp()
      where (status = 'running' and lease_until < clock_timestamp()) or status = 'needs_decision'
  returning id, fence, attempt_seq, input_hash`,
  );
  for (const r of rows) await enqueue(r.id, Number(r.fence), r.attempt_seq, r.input_hash);
}

export async function runChaos(args: {
  seed: number;
  stages: number;
  uploads: number;
  steps: number;
  brokenMode?: BrokenMode;
  deps: { db: TestDb };
}): Promise<ChaosResult> {
  const { seed, brokenMode } = args;
  const shape: Shape = { stages: args.stages, uploads: args.uploads, steps: args.steps };
  const plan = planFor(seed, shape);
  const { pool, redisUrl } = args.deps.db;
  const violations: string[] = [];
  const unexpected = (where: string, e: unknown) => {
    violations.push(`unexpected_error[${where}]: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  };

  await args.deps.db.reset();
  await installProbes(pool);

  // ---- data
  await pool.query("insert into budgets (scope, cap_micro_usd) values ('g', $1)", [plan.capG]);
  const stageIds: string[] = [];
  const stageIdx = new Map<string, number>();
  for (let i = 0; i < shape.stages; i++) {
    await pool.query("insert into budgets (scope, cap_micro_usd) values ($1, 1000000000)", [`v${i}`]);
    const id = await insertQueuedStage(pool, { videoId: uuidv7(), name: `s${i}`, inputHash: HASH });
    stageIds.push(id);
    stageIdx.set(id, i);
  }
  const videoIds = Array.from({ length: shape.uploads }, () => uuidv7());
  const uploadIds: string[] = [];
  const uploadIdx = new Map<string, number>();
  for (let i = 0; i < shape.uploads; i++) {
    const id = uuidv7();
    await pool.query(
      `insert into uploads (id, video_id, status, approval_hash, file_sha, channel_id, bytes_total)
       values ($1,$2,'publish_approved','appr','sha','chan',1000000)`,
      [id, videoIds[plan.uploads[i]!.video]!],
    );
    uploadIds.push(id);
    uploadIdx.set(id, i);
  }

  const script: Record<string, Outcome> = {};
  plan.stages.forEach((sp, i) => {
    for (let j = 0; j < shape.steps; j++) {
      const out = sp.knownFailStep === j ? knownFailure() : ok(sp.actual[j]!);
      script[callKey(stageIds[i]!, j, 0)] = sp.delayMs[j]! > 0 ? hangs(sp.delayMs[j]!, out) : out;
    }
  });
  const fake = createFakeProvider({ pool, script });
  await fake.init();

  const steps = (idx: number): StageStep[] =>
    Array.from({ length: shape.steps }, (_, j) => ({ stepIndex: j, toolCallIndex: 0, reserveMicroUsd: 1000, budgetScopes: ["g", `v${idx}`], kind: "paid" as const }));

  // ---- real SIGKILL phase (stage 0, a subset of seeds): the child claims, stops at a marker and is killed -9
  if (plan.realKill) {
    const child = spawnChildWorker({
      DATABASE_URL: pool.options.connectionString!,
      STAGE_ID: stageIds[0]!,
      INPUT_HASH: HASH,
      WORKER_ID: "child",
      STOP_AFTER: plan.realKill.marker,
      TTL_MS: String(TTL_MS),
    });
    try {
      await child.waitMarker(plan.realKill.marker, 60_000);
    } catch (e) {
      unexpected("real_kill", e);
    }
    await child.kill9();
  }

  // ---- queue + workers
  const queue = createJobQueue(redisUrl, "stages", `chaos-${process.pid}-${runCounter++}`);
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  let inflight = 0;
  const dropped = new Map<number, number>();
  const ordinals = new Map<number, Map<number, number>>();

  function wrapPaid(idx: number, base: PaidCallPorts): PaidCallPorts {
    let spec: CrashSpec | null | undefined;
    let lastStep = -1;
    const specFor = (fence: number): CrashSpec | null => {
      const m = ordinals.get(idx) ?? new Map<number, number>();
      ordinals.set(idx, m);
      if (!m.has(fence)) m.set(fence, m.size);
      return plan.stages[idx]!.crashes[m.get(fence)!] ?? null;
    };
    return {
      ...base,
      reserve: async (claim, a) => {
        if (spec === undefined) spec = specFor(claim.fence);
        lastStep = a.stepIndex;
        if (spec?.point === "after_claim" && a.stepIndex === 0) throw new CrashSignal("after_claim");
        const ra = brokenMode === "broken_call_key" ? { ...a, toolCallIndex: nonce++ } : a;
        const r = await base.reserve(claim, ra);
        if (spec?.point === "after_reserve" && a.stepIndex === spec.step && r.kind === "new") throw new CrashSignal("after_reserve");
        return r;
      },
      settle: async (intentId, a) => {
        if (spec?.point === "after_provider" && lastStep === spec.step) throw new CrashSignal("after_provider");
        await base.settle(intentId, a);
        if ((spec?.point === "after_settle" || spec?.point === "before_commit") && lastStep === spec.step) throw new CrashSignal(spec.point);
      },
      warn: () => {},
    };
  }

  async function deliver(idx: number, job: StageJob, workerId: string, viaQueue: boolean): Promise<void> {
    inflight++;
    try {
      if (viaQueue && (dropped.get(idx) ?? 0) < plan.stages[idx]!.dropBeforeClaim) {
        dropped.set(idx, (dropped.get(idx) ?? 0) + 1);
        return; // worker died before claiming: the delivery is simply lost
      }
      await runStage(
        pool,
        {
          provider: { call: (key) => fake.call(key) },
          ttlMs: TTL_MS,
          workerId,
          stepsFor: (stage) => steps(stageIdx.get(stage.id)!),
        },
        job,
        { paid: (b) => wrapPaid(idx, b), warn: () => {} },
      );
    } catch (e) {
      if (!(e instanceof CrashSignal)) unexpected(`stage s${idx}`, e);
      // CrashSignal: attempt abandoned without cleanup (the heartbeat timer is cleared by the runner's finally)
    } finally {
      inflight--;
    }
  }

  const onError = () => {}; // lock-lost style errors after FLUSHALL are expected noise
  const workers = ["w1", "w2"].map((wid) =>
    queue.startWorker(async (job) => deliver(stageIdx.get(job.stageRunId)!, job, wid, true), { concurrency: 3, onError }),
  );

  const doReconcile = async () => {
    try {
      if (brokenMode === "broken_requeue") await brokenReconcile(pool, (...a) => queue.enqueue(...a));
      else await reconcile(pool, queue, { graceMs: GRACE_MS });
    } catch (e) {
      unexpected("reconcile", e);
    }
  };

  // ---- uploads
  const starts = new Map<string, number>();
  const holds = new Map<string, () => void>();
  const holdPromises = new Map<string, Promise<void>>();
  uploadIds.forEach((id) => holdPromises.set(id, new Promise<void>((r) => holds.set(id, r))));
  const uploadDeps: UploadJobDeps = {
    startCtx: (): StartCtx => ({ currentApprovalHash: "appr", currentFileSha: "sha", caps: CAPS }),
    uploader: {
      async upload(uploadId, onProgress) {
        starts.set(uploadId, (starts.get(uploadId) ?? 0) + 1);
        const done = { kind: "uploaded" as const, youtubeId: `yt-${uploadId}` };
        switch (plan.uploads[uploadIdx.get(uploadId)!]!.behavior) {
          case "ok":
            await onProgress(100);
            await sleep(20);
            await onProgress(500);
            return done;
          case "fail":
            await onProgress(50);
            return { kind: "failed", reason: "chaos provider said no" };
          case "hang":
            await onProgress(100);
            return new Promise<never>(() => {}); // crash mid-upload: the uploader never returns
          case "late_success":
            await onProgress(100);
            await holdPromises.get(uploadId); // reports success only after it was stalled
            return done;
          case "slow_stall":
            await onProgress(100);
            await sleep(STALL_MS * 2);
            await onProgress(300); // rejected (superseded) when it was stalled meanwhile
            return done;
        }
      },
    },
  };
  const settled = new Map<Promise<void>, number>(); // delivery promise -> upload index while unsettled
  const trackUpload = (i: number, p: Promise<void>) => {
    settled.set(p, i);
    void p.then(() => settled.delete(p));
  };
  async function deliverUpload(i: number, k: number): Promise<void> {
    const id = uploadIds[i]!;
    try {
      if (brokenMode === "broken_upload_door" && k > 0) {
        // the door without the publish_approved guard: straight to uploading, whatever the status
        const r = await pool.query<{ attempt: number }>(
          "update uploads set status = 'uploading', attempt = attempt + 1, started_at = clock_timestamp(), last_progress_at = clock_timestamp() where id = $1 returning attempt",
          [id],
        );
        await runUpload(pool, uploadDeps, id, r.rows[0]!.attempt);
      } else {
        await handleUploadJob(pool, uploadDeps, id);
      }
    } catch (e) {
      unexpected(`upload u${i}`, e);
    }
  }
  async function staleReport(i: number): Promise<void> {
    const id = uploadIds[i]!;
    // attempt 0 and 9999 can never be a live attempt (a start bumps to >= 1; at most a handful of starts happen)
    for (const attempt of [0, 9999]) {
      try {
        if (await finishUpload(pool, id, attempt, { kind: "uploaded", youtubeId: `stale-${id}` })) {
          violations.push(`I2 stale attempt ${attempt} report was accepted for upload u${i}`);
        }
      } catch (e) {
        unexpected(`stale u${i}`, e);
      }
    }
  }

  // ---- run phase: faults interleaved with normal work
  const t0 = Date.now();
  const at = (ms: number, fn: () => Promise<unknown>): Promise<void> =>
    sleep(Math.max(0, ms - (Date.now() - t0))).then(fn).then(
      () => undefined,
      (e) => unexpected("schedule", e),
    );
  const tasks: Array<Promise<void>> = [];
  plan.stages.forEach((sp, i) => {
    const id = stageIds[i]!;
    const job: StageJob = { stageRunId: id, inputHash: HASH };
    if (!(plan.realKill && i === 0)) tasks.push(at(0, () => queue.enqueue(id, 0, 0, HASH)));
    for (let k = 0; k < sp.extraDeliveries; k++) tasks.push(at(0, () => queue.enqueue(id, 0, 1000 + k, HASH)));
    if (sp.directDups > 0) {
      tasks.push(at(sp.directDupAtMs, () => Promise.all(Array.from({ length: sp.directDups }, (_, d) => deliver(i, job, `d${d}`, false)))));
    }
  });
  plan.uploads.forEach((up, i) => {
    for (let k = 0; k < up.dupStarts; k++) {
      tasks.push(at(up.dupDelaysMs[k]!, async () => {
        // broken door: the duplicate arrives after the first start had its chance
        const p = deliverUpload(i, k);
        trackUpload(i, p);
        await Promise.race([p, sleep(30)]);
      }));
    }
    if (up.staleReportAtMs >= 0) tasks.push(at(up.staleReportAtMs, () => staleReport(i)));
  });
  for (const ev of plan.events) {
    tasks.push(at(ev.atMs, async () => {
      switch (ev.kind) {
        case "flush":
          await redis.flushall();
          break;
        case "reconcile":
          await (ev.double ? Promise.all([doReconcile(), doReconcile()]) : doReconcile());
          break;
        case "mark_stalled":
          await markStalled(pool, STALL_MS);
          break;
        case "expire_lease":
          await pool.query("update stage_runs set lease_until = clock_timestamp() - interval '1 second' where id = $1 and status = 'running'", [stageIds[ev.stage]]);
          break;
      }
    }));
  }
  await Promise.all(tasks);

  // ---- quiesce
  const maxRounds = brokenMode === "broken_requeue" ? 6 : 80;
  let stable = 0;
  let lastSig = "";
  let converged = false;
  try {
    for (let round = 0; round < maxRounds; round++) {
      await sleep(GRACE_MS + 20);
      await waitFor(() => inflight === 0, "stage handlers drained", 10_000);
      await pool.query("update stage_runs set lease_until = clock_timestamp() - interval '1 second' where status = 'running'");
      await (round % 3 === 2 ? Promise.all([doReconcile(), doReconcile()]) : doReconcile());
      await sleep(30);
      await waitFor(() => inflight === 0, "stage handlers drained", 10_000);
      const { rows } = await pool.query<{ id: string; status: string; fence: string; attempt_seq: number }>(
        "select id, status, fence, attempt_seq from stage_runs order by id",
      );
      const sig = JSON.stringify(rows);
      const open = rows.some((r) => r.status === "running" || r.status === "queued");
      stable = !open && sig === lastSig ? stable + 1 : 0;
      lastSig = sig;
      if (stable >= 2) {
        converged = true;
        break;
      }
    }
  } catch (e) {
    unexpected("quiesce", e);
  }
  if (!converged && brokenMode !== "broken_requeue") violations.push("I3 quiesce did not converge");

  // uploads: let everything that can finish finish, stall the rest, then release late successes
  try {
    await waitFor(() => [...settled.values()].every((i) => ["hang", "late_success"].includes(plan.uploads[i]!.behavior)), "uploads settled", 15_000);
    await markStalled(pool, 1);
    for (const r of holds.values()) r();
    await waitFor(() => [...settled.values()].every((i) => plan.uploads[i]!.behavior === "hang"), "late successes reported", 15_000);
    await markStalled(pool, 1);
  } catch (e) {
    unexpected("upload quiesce", e);
  }

  // ---- results + invariants
  const calls = new Map<string, number>();
  for (const r of (await pool.query<{ call_key: string; n: number }>("select call_key, count(*)::int as n from fake_provider_calls group by call_key")).rows) {
    calls.set(r.call_key, r.n);
    if (r.n > 1) violations.push(`I1 call key ${r.call_key} was called ${r.n} times`);
  }

  for (const [id, n] of starts) if (n > 1) violations.push(`I2 upload u${uploadIdx.get(id)} (${id}) had ${n} uploader starts`);
  const dupVideo = await pool.query("select video_id, count(*) from uploads where status in ('uploading','uploaded') group by video_id having count(*) > 1");
  if (dupVideo.rowCount) violations.push("I2 a video has more than one uploading|uploaded row");

  const stageRows = (await pool.query<{ id: string; status: string }>("select id, status from stage_runs")).rows;
  const finalStageStatuses: Record<string, string> = {};
  for (const r of stageRows) finalStageStatuses[`s${stageIdx.get(r.id)}`] = r.status;
  for (const r of stageRows) {
    if (r.status === "running") violations.push(`I3 stage s${stageIdx.get(r.id)} is still running after quiesce`);
    if (r.status === "queued" && brokenMode !== "broken_requeue") violations.push(`I3 stage s${stageIdx.get(r.id)} is still queued after quiesce`);
  }
  const uploadRows = (await pool.query<{ id: string; status: string }>("select id, status from uploads")).rows;
  const finalUploadStatuses: Record<string, string> = {};
  for (const r of uploadRows) {
    finalUploadStatuses[`u${uploadIdx.get(r.id)}`] = r.status;
    if (r.status === "uploading") violations.push(`I3 upload u${uploadIdx.get(r.id)} is stuck uploading after markStalled`);
  }

  // I4 budgets
  let budgetConsistent = true;
  const bud = (await pool.query<{ scope: string; cap: string; reserved: string; spent: string }>(
    "select scope, cap_micro_usd as cap, reserved_micro_usd as reserved, spent_micro_usd as spent from budgets",
  )).rows;
  const intents = (await pool.query<{ status: string; scopes: string[]; reserved: string; actual: string | null; stage_run_id: string; step_index: number }>(
    "select status, scopes, reserved_micro_usd as reserved, actual_micro_usd as actual, stage_run_id, step_index from spend_intents",
  )).rows;
  for (const b of bud) {
    let rs = 0;
    let sp = 0;
    for (const it of intents) {
      if (!it.scopes.includes(b.scope)) continue;
      if (it.status === "pending" || it.status === "unknown") rs += Number(it.reserved);
      if (it.status === "done") sp += Number(it.actual ?? 0);
    }
    if (rs !== Number(b.reserved) || sp !== Number(b.spent) || Number(b.reserved) + Number(b.spent) > Number(b.cap)) {
      budgetConsistent = false;
      violations.push(`I4 budget ${b.scope}: table reserved=${b.reserved} spent=${b.spent} cap=${b.cap}; intents reserved=${rs} spent=${sp}`);
    }
  }

  // I5: a succeeded stage has every step's intent done; terminal states are never left
  for (const r of stageRows.filter((x) => x.status === "succeeded")) {
    for (let j = 0; j < shape.steps; j++) {
      if (!intents.some((it) => it.stage_run_id === r.id && it.step_index === j && it.status === "done")) {
        violations.push(`I5 stage s${stageIdx.get(r.id)} succeeded without a done intent for step ${j}`);
      }
    }
  }
  const trans = (await pool.query<{ kind: string; row_id: string; old_status: string; new_status: string }>(
    "select kind, row_id, old_status, new_status from chaos_transitions order by seq",
  )).rows;
  for (const t of trans) {
    if (t.kind === "stage" && TERMINAL.has(t.old_status)) {
      violations.push(`I5 stage s${stageIdx.get(t.row_id)} left ${t.old_status} for ${t.new_status}`);
    }
    if (t.kind === "upload" && t.new_status === "uploading" && t.old_status !== "publish_approved") {
      violations.push(`I2 upload u${uploadIdx.get(t.row_id)} went ${t.old_status} -> uploading without a human retry`);
    }
    if (t.kind === "upload" && t.old_status === "uploaded") {
      violations.push(`I2 upload u${uploadIdx.get(t.row_id)} left uploaded for ${t.new_status}`);
    }
  }

  await Promise.all(workers.map((w) => w.close())).catch(() => {});
  await queue.close().catch(() => {});
  redis.disconnect();

  return {
    seed,
    providerCallsByKey: calls,
    uploaderStartsByUploadId: starts,
    finalStageStatuses,
    finalUploadStatuses,
    budgetConsistent,
    violations,
  };
}
