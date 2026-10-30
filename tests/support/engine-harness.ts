import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Redis } from "ioredis";
import type pg from "pg";
import { sha256Hex } from "@/server/core/content-hash";
import type { GateActor } from "@/server/core/approvals";
import type { GateId } from "@/server/core/gates";
import { uuidv7 } from "@/server/core/ids";
import { versionsKey } from "@/server/core/queue-input";
import { approvalReaders } from "@/server/db/approval-readers";
import { liveGateHash } from "@/server/db/approvals";
import { getDecision } from "@/server/db/decision";
import { readNextAction } from "@/server/db/pipeline";
import { decideGate, decideParkedStage, type Queues } from "@/server/db/queue-actions";
import { addContent, createVideoRow } from "@/server/db/videos";
import { createJobQueue, type StageQueue, type UploadQueue } from "@/server/queue/job-queue";
import type { TestDb } from "./db";

// Shared pieces of the Task 25 resilience suite: real worker child processes, a fault plan file, the owner's actions through
// the same functions the /queue page calls, and the invariants every scenario must keep.

const HELPER = fileURLToPath(new URL("../integration/helpers/engine-worker.ts", import.meta.url));
const REPO = fileURLToPath(new URL("../..", import.meta.url));

export interface Plan {
  crash?: { stage: string; point: "a" | "b" | "c" | "d" | "e"; nth?: number };
  hang?: { stage: string; ms: number; nth?: number };
  freshKey?: boolean;
}

export interface EngineWorker {
  child: ChildProcess;
  id: string;
  output(): string;
  alive(): boolean;
  exited: Promise<void>;
  ready(timeoutMs?: number): Promise<void>;
  kill9(): Promise<void>;
  stop(): Promise<void>;
}

const live = new Set<ChildProcess>();

export async function killAllEngineWorkers(): Promise<void> {
  await Promise.all([...live].map((c) => new Promise<void>((r) => {
    if (c.exitCode !== null || c.signalCode !== null) return r();
    c.once("exit", () => r());
    c.kill("SIGKILL");
  })));
}

export async function waitUntil<T>(probe: () => Promise<T | false | null | undefined> | T | false | null | undefined, label: string, timeoutMs = 60_000, everyMs = 40): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

export interface World {
  db: TestDb;
  root: string;
  planFile: string;
  session: GateActor;
  queues: Queues & { stageQueue: StageQueue; uploadQueue: UploadQueue };
  setPlan(p: Plan): void;
  spawnWorker(id?: string): EngineWorker;
  flushRedis(): Promise<void>;
  newVideo(topic?: string): Promise<string>;
  close(): Promise<void>;
}

/** Run once per test file, after withTestDb(). */
export async function prepareEngineTables(db: TestDb): Promise<void> {
  await db.ownerPool.query("create table if not exists engine_calls (real_key text not null, logical_key text not null, at timestamptz not null default now())");
  await db.ownerPool.query("grant select, insert on engine_calls to ytstudio_app");
}

/** Run before every test (after db.reset()): caps, an owner session, a fresh storage folder and queues. */
export async function openWorld(db: TestDb): Promise<World> {
  await db.pool.query("insert into budgets (scope, cap_micro_usd) values ('draft_run', 3000000), ('video:scene_kit', 2000000), ('day', 15000000), ('month', 100000000)");
  const sessionId = uuidv7();
  await db.pool.query(
    "insert into sessions (id, token_hash, expires_at, absolute_expires_at) values ($1, $2, clock_timestamp() + interval '1 day', clock_timestamp() + interval '7 days')",
    [sessionId, `engine-${sessionId}`],
  );
  const root = mkdtempSync(path.join(tmpdir(), "engine-"));
  const planFile = path.join(root, "plan.json");
  writeFileSync(planFile, "{}");
  const stageQueue = createJobQueue(db.redisUrl, "stages");
  const uploadQueue = createJobQueue(db.redisUrl, "uploads");
  const children: ChildProcess[] = [];
  let seq = 0;
  const world: World = {
    db, root, planFile,
    session: { kind: "session", sessionId },
    queues: { stage: stageQueue, upload: uploadQueue, stageQueue, uploadQueue },
    setPlan: (p) => writeFileSync(planFile, JSON.stringify(p)),
    spawnWorker(id = `w${++seq}`) {
      const child = spawn(process.execPath, ["--import", "tsx", HELPER], {
        cwd: REPO,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          DATABASE_URL: db.pool.options.connectionString!, REDIS_URL: db.redisUrl, STORAGE_ROOT: root, WORKER_ID: id, PLAN_FILE: planFile,
        },
      });
      live.add(child);
      children.push(child);
      let out = "";
      child.stdout!.on("data", (d) => (out += d));
      child.stderr!.on("data", (d) => (out += d));
      const exited = new Promise<void>((r) => child.once("exit", () => r()));
      void exited.then(() => live.delete(child));
      const alive = () => child.exitCode === null && child.signalCode === null;
      return {
        child, id, exited, alive, output: () => out,
        ready: (timeoutMs = 60_000) => waitUntil(() => {
          if (out.split("\n").includes("READY")) return true;
          if (!alive()) throw new Error(`engine worker ${id} exited before READY:\n${out}`);
          return false;
        }, `worker ${id} READY`, timeoutMs).then(() => undefined),
        async kill9() { if (alive()) child.kill("SIGKILL"); await exited; },
        async stop() {
          if (!alive()) return;
          child.kill("SIGTERM");
          const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
          await exited;
          clearTimeout(timer);
        },
      };
    },
    async flushRedis() {
      const r = new Redis(db.redisUrl, { maxRetriesPerRequest: 1 });
      try { await r.flushall(); } finally { r.disconnect(); }
    },
    async newVideo(topic = "Why do octopuses have three hearts?") {
      const v = await createVideoRow(db.pool, { format: "short", kind: "scene_kit", language: "en", topic });
      return v.id;
    },
    async close() {
      await Promise.all(children.map((c) => new Promise<void>((r) => {
        if (c.exitCode !== null || c.signalCode !== null) return r();
        c.once("exit", () => r());
        c.kill("SIGKILL");
      })));
      await stageQueue.close().catch(() => undefined);
      await uploadQueue.close().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    },
  };
  return world;
}

// --- the owner ----------------------------------------------------------------------------------------------------------

/** What a Phase 4/5 producer would have saved by the time the owner reaches the evidence and publish gates. */
export async function ensureLaterContent(db: pg.Pool, videoId: string): Promise<void> {
  const have = (await db.query<{ kind: string }>("select distinct kind from video_content where video_id = $1", [videoId])).rows.map((r) => r.kind);
  if (!have.includes("evidence")) await addContent(db, videoId, "evidence", { filePath: `evidence/${videoId}.pdf`, sha256: sha256Hex(`evidence-${videoId}`) });
  if (!have.includes("metadata")) await addContent(db, videoId, "metadata", { body: { title: "Octopus hearts", visibility: "private", publish_at: null }, sha256: sha256Hex(`metadata-${videoId}`) });
  await db.query("update videos set channel_id = coalesce(channel_id, 'UC-test') where id = $1", [videoId]);
}

export type OwnerStep =
  | { kind: "done" }
  | { kind: "gate"; gate: GateId; ok: boolean; message: string }
  | { kind: "parked"; stageRunId: string; choice: string; ok: boolean; message: string }
  | { kind: "idle" };

export interface OwnerOptions {
  /** Which way the owner settles a parked stage. */
  parked?: "release_and_rerun" | "keep_spent_and_rerun" | "cancel_video" | "use_result" | "none";
  /** Gates the owner leaves alone (the test acts on them by hand). */
  skipGates?: GateId[];
  /** Stop playing as soon as this is true (checked every turn). */
  until?: () => Promise<boolean>;
  /** Approve each gate twice at once (a double click / two tabs). */
  doubleApprove?: boolean;
}

/** One owner action, if the video is waiting for one. The same functions the /queue page calls. */
export async function ownerStep(w: World, videoId: string, o: OwnerOptions = {}): Promise<OwnerStep> {
  const db = w.db.pool;
  const next = await readNextAction(db, videoId, approvalReaders);
  if (!next || next.kind === "done") return { kind: "done" };
  if (next.kind === "wait_gate") {
    if (o.skipGates?.includes(next.gate)) return { kind: "idle" };
    if (next.gate === "evidence" || next.gate === "publish") await ensureLaterContent(db, videoId);
    const live = await liveGateHash(db, videoId, next.gate);
    if (!live) return { kind: "idle" };
    const input = { videoId, gate: next.gate as never, seenHash: live.hash, seenVersions: versionsKey(live.versions), note: undefined, captionsChecked: true }; // the dry run's captions are estimated: the owner ticks
    const rs = await Promise.all(Array.from({ length: o.doubleApprove ? 2 : 1 }, () => decideGate(db, w.queues, w.session, input, "approve", { root: w.root })));
    const r = rs.find((x) => x.ok) ?? rs[0]!;
    return { kind: "gate", gate: next.gate, ok: r.ok, message: r.message };
  }
  if (next.kind === "wait_stage" && next.status === "needs_decision" && o.parked !== "none") {
    const row = (await db.query<{ id: string }>("select id from stage_runs where video_id = $1 and name = $2 and status = 'needs_decision' order by created_at desc limit 1", [videoId, next.stage])).rows[0];
    if (!row) return { kind: "idle" };
    const d = await getDecision(db, row.id);
    if (!d) return { kind: "idle" };
    const choice = o.parked ?? "release_and_rerun";
    const r = await decideParkedStage(db, w.queues, w.session, { stageRunId: row.id, choice, seenMaxMicroUsd: d.maxCostMicroUsd, seenReason: d.reason, confirmed: true });
    return { kind: "parked", stageRunId: row.id, choice, ok: r.ok, message: r.message };
  }
  return { kind: "idle" };
}

/** Plays the owner until the upload is done (or the video ends some other way). Returns every action it took. */
export async function runToUploaded(w: World, videoId: string, o: OwnerOptions = {}, timeoutMs = 120_000): Promise<OwnerStep[]> {
  const taken: OwnerStep[] = [];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (o.until && (await o.until())) return taken;
    const s = await ownerStep(w, videoId, o);
    if (s.kind === "gate" || s.kind === "parked") taken.push(s);
    if (s.kind === "parked" && !s.ok) throw new Error(`owner could not resolve parked stage ${s.stageRunId}: ${s.message}\n${await dump(w.db.pool, videoId)}`);
    if (s.kind === "done" || (await uploadStatus(w.db.pool, videoId)) === "uploaded") {
      if ((await uploadStatus(w.db.pool, videoId)) === "uploaded") return taken;
    }
    if ((await w.db.pool.query("select status from videos where id = $1", [videoId])).rows[0]?.status === "cancelled") return taken;
    if (Date.now() > deadline) throw new Error(`video ${videoId} did not reach uploaded in time; next=${JSON.stringify(await readNextAction(w.db.pool, videoId, approvalReaders))}\n${await dump(w.db.pool, videoId)}`);
    await new Promise((r) => setTimeout(r, 60));
  }
}

export async function uploadStatus(db: pg.Pool, videoId: string): Promise<string | null> {
  return (await db.query<{ status: string }>("select status from uploads where video_id = $1 order by created_at desc limit 1", [videoId])).rows[0]?.status ?? null;
}

export async function dump(db: pg.Pool, videoId: string): Promise<string> {
  const s = (await db.query("select name, status, fence, attempt_seq, left(input_hash, 6) h from stage_runs where video_id = $1 order by created_at, id", [videoId])).rows;
  const i = (await db.query("select i.call_key, i.status, i.reserved_micro_usd r, i.actual_micro_usd a from spend_intents i join stage_runs s on s.id = i.stage_run_id where s.video_id = $1 order by i.created_at", [videoId])).rows;
  return JSON.stringify({ stages: s, intents: i });
}

// --- invariants ---------------------------------------------------------------------------------------------------------

export interface Counts {
  stageRuns: Record<string, number>;
  providerCalls: number;
  settledMicroUsd: number;
}

/**
 * The rules every scenario keeps, read from the database and the independent call tables (never from the product's own
 * counters). Returns the violations; an empty list means no double work and no double spend.
 */
export async function violations(db: pg.Pool, opts: { videoIds?: string[] } = {}): Promise<string[]> {
  const v: string[] = [];
  // I1: one provider call per call key (what the provider saw) ...
  for (const r of (await db.query<{ call_key: string; n: number }>("select call_key, count(*)::int n from fake_provider_calls where call_key not like 'fake:upload:%' group by call_key having count(*) > 1")).rows) v.push(`I1 call key ${r.call_key} reached the provider ${r.n} times`);
  // ... and one provider call per LOGICAL step, even if the product minted a different key for it.
  for (const r of (await db.query<{ logical_key: string; n: number }>("select logical_key, count(*)::int n from engine_calls group by logical_key having count(*) > 1")).rows) v.push(`I1b step ${r.logical_key} reached the provider ${r.n} times`);
  // I2: one start per upload, one provider-side upload call per upload row.
  for (const r of (await db.query<{ id: string; attempt: number }>("select id, attempt from uploads where attempt > 1")).rows) v.push(`I2 upload ${r.id} started ${r.attempt} times`);
  for (const r of (await db.query<{ call_key: string; n: number }>("select call_key, count(*)::int n from fake_provider_calls where call_key like 'fake:upload:%' group by call_key having count(*) > 1")).rows) v.push(`I2 ${r.call_key} called ${r.n} times`);
  for (const r of (await db.query<{ video_id: string; n: number }>("select video_id, count(*)::int n from uploads where status in ('uploading','uploaded') group by video_id having count(*) > 1")).rows) v.push(`I2 video ${r.video_id} has ${r.n} live uploads`);
  // I3: each stage once per (video, input) among rows that are not dead.
  for (const r of (await db.query<{ video_id: string; name: string; n: number }>("select video_id, name, count(*)::int n from stage_runs where status in ('queued','running','succeeded','needs_decision') group by video_id, name, input_hash having count(*) > 1")).rows) v.push(`I3 ${r.name} of ${r.video_id} has ${r.n} live rows for one input`);
  // I4: the money tables agree with the intents, and nothing is over its cap.
  const budgets = (await db.query<{ scope: string; cap: string; reserved: string; spent: string }>("select scope, cap_micro_usd cap, reserved_micro_usd reserved, spent_micro_usd spent from budgets")).rows;
  const intents = (await db.query<{ status: string; scopes: string[]; reserved: string; actual: string | null }>("select status, scopes, reserved_micro_usd reserved, actual_micro_usd actual from spend_intents")).rows;
  for (const b of budgets) {
    let rs = 0, sp = 0;
    for (const it of intents) {
      if (!it.scopes.includes(b.scope)) continue;
      if (it.status === "pending" || it.status === "unknown") rs += Number(it.reserved);
      if (it.status === "done") sp += Number(it.actual ?? 0);
    }
    if (rs !== Number(b.reserved) || sp !== Number(b.spent)) v.push(`I4 budget ${b.scope}: table reserved=${b.reserved} spent=${b.spent}; intents reserved=${rs} spent=${sp}`);
    if (Number(b.reserved) + Number(b.spent) > Number(b.cap)) v.push(`I4 budget ${b.scope} is over its cap`);
  }
  // I5: every provider call has a matching intent (no call without a reservation) and at most one done intent per call.
  for (const r of (await db.query<{ call_key: string }>("select distinct f.call_key from fake_provider_calls f left join spend_intents i on i.call_key = f.call_key where f.call_key not like 'fake:upload:%' and i.call_key is null")).rows) v.push(`I5 provider call ${r.call_key} had no reservation`);
  // I6: no approval row for a hash other than what the owner saw is checked by the approval tests; here: an approved
  // gate row always carries a 64-hex hash.
  for (const r of (await db.query<{ id: string }>("select id from approvals where decision = 'approved' and content_hash !~ '^[0-9a-f]{64}$'")).rows) v.push(`I6 approval ${r.id} has no hash`);
  void opts;
  return v;
}

export async function counts(db: pg.Pool, videoId: string): Promise<Counts> {
  const stageRuns: Record<string, number> = {};
  for (const r of (await db.query<{ name: string; n: number }>("select name, count(*)::int n from stage_runs where video_id = $1 group by name", [videoId])).rows) stageRuns[r.name] = r.n;
  const providerCalls = (await db.query<{ n: number }>("select count(*)::int n from engine_calls e join spend_intents i on i.call_key = e.real_key join stage_runs s on s.id = i.stage_run_id where s.video_id = $1", [videoId])).rows[0]!.n;
  const settledMicroUsd = Number((await db.query<{ n: string }>("select coalesce(sum(i.actual_micro_usd), 0) n from spend_intents i join stage_runs s on s.id = i.stage_run_id where s.video_id = $1 and i.status = 'done'", [videoId])).rows[0]!.n);
  return { stageRuns, providerCalls, settledMicroUsd };
}

// --- supervisor ---------------------------------------------------------------------------------------------------------

export interface Supervisor {
  current(): EngineWorker;
  crashes(): number;
  stop(): Promise<void>;
}

/**
 * Plays dev:all's restart loop: when the worker dies, the lease it held is let run out (the one thing real time does that a
 * test must do by hand), the fault plan is cleared and a replacement starts.
 */
export function supervise(w: World, plan: Plan = {}): Supervisor {
  w.setPlan(plan);
  let stopping = false;
  let n = 0;
  let cur = w.spawnWorker(`s${++n}`);
  const loop = (async () => {
    for (;;) {
      await cur.exited;
      if (stopping) return;
      try {
      const dead = cur.id;
      await w.db.pool.query("update stage_runs set lease_until = clock_timestamp() - interval '1 second' where status = 'running' and lease_owner = $1", [dead]);
      w.setPlan({ ...plan, crash: undefined }); // the crash fired; a mutation (freshKey) stays on
      cur = w.spawnWorker(`s${++n}`);
      } catch { return; } // the world was torn down under us
    }
  })();
  return {
    current: () => cur,
    crashes: () => n - 1,
    async stop() {
      stopping = true;
      await cur.stop();
      await loop;
    },
  };
}
