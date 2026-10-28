import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import { uuidv7 } from "@/server/core/ids";
import { versionsKey } from "@/server/core/queue-input";
import { approveGate, liveGateHash } from "@/server/db/approvals";
import { decideGate } from "@/server/db/queue-actions";
import { addContent } from "@/server/db/videos";
import { mulberry32 } from "../support/chaos";
import { withTestDb, type TestDb } from "../support/db";
import {
  killAllEngineWorkers, openWorld, prepareEngineTables, runToUploaded, supervise, uploadStatus, violations, waitUntil, dump,
  type Plan, type World,
} from "../support/engine-harness";

// Task 25 chaos sweep over the WHOLE fake pipeline: per seed one video is made while a seeded mix of faults is thrown at it
// (SIGKILL at one of five points, FLUSHALL, a lease running out, double approvals). Every seed must end with the video
// uploaded exactly once and violations() empty. The mutation checks prove the net has holes where the guards are removed.
// Replay one seed with ENGINE_CHAOS_SEED_ONLY=<n>; seed count with ENGINE_CHAOS_SEEDS (default 60 in CI, 200 locally).

const N = Number(process.env.ENGINE_CHAOS_SEEDS ?? (process.env.CI ? 60 : 200));
const ONLY = process.env.ENGINE_CHAOS_SEED_ONLY ? Number(process.env.ENGINE_CHAOS_SEED_ONLY) : null;
const POINTS = ["a", "b", "c", "d", "e"] as const;
const PAID: Array<[string, number]> = [["draft", 0], ["draft", 1], ["generate", 0], ["tts", 0]];

let db: TestDb;
let w: World | undefined;
beforeAll(async () => {
  db = await withTestDb();
  await prepareEngineTables(db);
}, 180_000);
afterEach(async () => {
  await killAllEngineWorkers();
});
afterAll(async () => {
  await w?.close();
  await db?.stop();
});
async function fresh(): Promise<World> {
  await w?.close();
  await db.reset();
  w = await openWorld(db);
  return w;
}
const q = (sql: string, args: unknown[] = []) => db.pool.query(sql, args);

export interface SeedPlan {
  seed: number;
  crash: Plan["crash"];
  flushAfterMs: number | null;
  expireLeaseAfterMs: number | null;
  doubleApprove: boolean;
  parked: "release_and_rerun" | "keep_spent_and_rerun";
}
export function planFor(seed: number): SeedPlan {
  const rnd = mulberry32(seed * 7919);
  // Keep no-crash control seeds, but do not align their cadence with the five-point rotation (that would permanently
  // remove one crash point from the sweep).
  const crashes = seed % 7 !== 0;
  const point = POINTS[seed % POINTS.length]!;
  // An unknown outcome in the middle of a multi-call stage is intentionally not auto-runnable: earlier settled calls
  // would be bought twice. Exercise ambiguous outcomes on the single-call TTS step; multi-call stages still take a/d/e.
  const [stage, nth] = point === "b" || point === "c" ? ["tts", 0] : PAID[Math.floor(rnd() * PAID.length)]!;
  return {
    seed,
    crash: crashes ? { stage, point, nth } : undefined,
    flushAfterMs: rnd() < 0.4 ? 200 + Math.floor(rnd() * 1800) : null,
    expireLeaseAfterMs: rnd() < 0.3 ? 200 + Math.floor(rnd() * 1800) : null,
    doubleApprove: rnd() < 0.5,
    parked: rnd() < 0.5 ? "release_and_rerun" : "keep_spent_and_rerun",
  };
}

async function runSeed(world: World, p: SeedPlan): Promise<{ crashes: number; vios: string[] }> {
  const sup = supervise(world, { crash: p.crash });
  const videoId = await world.newVideo(`Chaos seed ${p.seed}`);
  const faults: Array<Promise<void>> = [];
  const later = (ms: number | null, fn: () => Promise<unknown>) => { if (ms !== null) faults.push(new Promise<void>((r) => setTimeout(() => void fn().catch(() => undefined).then(() => r()), ms))); };
  later(p.flushAfterMs, () => world.flushRedis());
  later(p.expireLeaseAfterMs, () => q("update stage_runs set lease_until = clock_timestamp() - interval '1 second' where status = 'running'"));
  try {
    await runToUploaded(world, videoId, { doubleApprove: p.doubleApprove, parked: p.parked }, 120_000);
    await Promise.all(faults);
  } catch (e) {
    await sup.stop();
    return { crashes: sup.crashes(), vios: [`LIVENESS seed ${p.seed}: ${(e as Error).message.slice(0, 600)}`] };
  }
  await sup.stop();
  const vios = await violations(db.pool);
  if ((await uploadStatus(db.pool, videoId)) !== "uploaded") vios.push(`seed ${p.seed}: video did not end uploaded`);
  // The daily upload cap is a real rule (6 a day); chaos moves finished uploads into the past so every seed can upload.
  await db.ownerPool.query("update uploads set started_at = started_at - interval '2 days', finished_at = finished_at - interval '2 days', created_at = created_at - interval '2 days'");
  return { crashes: sup.crashes(), vios };
}

describe("engine chaos sweep", () => {
  it("every_seed_ends_uploaded_exactly_once_with_no_double_work_or_double_spend", async () => {
    const world = await fresh();
    const seeds = ONLY !== null ? [ONLY] : Array.from({ length: N }, (_, i) => i + 1);
    const failures: string[] = [];
    let crashes = 0;
    const pointsSeen = new Set<string>();
    const t0 = Date.now();
    for (const seed of seeds) {
      const p = planFor(seed);
      const r = await runSeed(world, p);
      crashes += r.crashes;
      if (r.crashes > 0 && p.crash) pointsSeen.add(p.crash.point);
      if (r.vios.length) failures.push(`seed ${seed} (replay: ENGINE_CHAOS_SEED_ONLY=${seed}) plan=${JSON.stringify(p)}\n  ${r.vios.join("\n  ")}`);
    }
    console.error(`engine chaos: ${seeds.length} seeds, ${crashes} real SIGKILLs, crash points hit ${[...pointsSeen].sort().join("")}, ${Math.round((Date.now() - t0) / 1000)}s`);
    expect(failures).toEqual([]);
    expect((await q("select count(*)::int n from uploads where status = 'uploaded'")).rows[0].n).toBe(seeds.length);
    if (ONLY === null && N >= 25) {
      expect(crashes).toBeGreaterThan(seeds.length / 2);
      expect([...pointsSeen].sort().join("")).toBe("abcde");
    }
  }, 3 * 3600_000);
});

describe("mutation checks: the harness fails when a guard is removed", () => {
  it("a_fresh_call_key_per_attempt_is_caught_by_the_logical_step_check", async () => {
    const world = await fresh();
    // crash after settle, before commit -- with the guard (stable keys) the restart replays the stored result; with a fresh key per attempt it buys the narration again
    const sup = supervise(world, { crash: { stage: "tts", point: "d", nth: 0 }, freshKey: true });
    const videoId = await world.newVideo();
    try { await runToUploaded(world, videoId, {}, 120_000); } finally { await sup.stop(); }
    const v = await violations(db.pool);
    expect(v.some((x) => x.startsWith("I1b"))).toBe(true);
    expect(v.some((x) => x.startsWith("I1 "))).toBe(false); // the key-based check alone would have missed it
  }, 300_000);

  it("advance_without_the_unique_index_creates_duplicate_stage_rows_and_the_harness_sees_it", async () => {
    const world = await fresh();
    const videoId = await world.newVideo();
    const naive = () => q("insert into stage_runs (id, video_id, name, status, input_hash) values ($1, $2, 'draft', 'queued', 'h') on conflict do nothing", [uuidv7(), videoId]);
    // guard in place: five racing inserts leave one row
    await Promise.all([1, 2, 3, 4, 5].map(naive));
    expect((await q("select count(*)::int n from stage_runs where video_id = $1", [videoId])).rows[0].n).toBe(1);
    expect((await violations(db.pool)).filter((x) => x.startsWith("I3"))).toEqual([]);
    // guard removed
    await db.ownerPool.query("drop index stage_runs_pipeline_unique");
    try {
      await q("delete from stage_runs where video_id = $1", [videoId]);
      await Promise.all([1, 2, 3, 4, 5].map(naive));
      expect((await q("select count(*)::int n from stage_runs where video_id = $1", [videoId])).rows[0].n).toBe(5);
      expect((await violations(db.pool)).some((x) => x.startsWith("I3"))).toBe(true);
    } finally {
      await q("delete from stage_runs where video_id = $1", [videoId]);
      await db.ownerPool.query("create unique index stage_runs_pipeline_unique on stage_runs (video_id, name, input_hash) where status in ('queued', 'running', 'succeeded', 'needs_decision')");
    }
  }, 120_000);

  it("an_approval_without_the_hash_check_records_text_the_owner_never_saw_and_the_harness_sees_it", async () => {
    const world = await fresh();
    const videoId = await world.newVideo();
    const body = (n: string) => ({ title: "t", narration: n });
    await addContent(db.pool, videoId, "script", { body: body("one"), sha256: sha256Hex(canonicalJson(body("one"))) });
    const viewed = (await liveGateHash(db.pool, videoId, "script"))!;
    // the text changes under the owner's eyes
    await addContent(db.pool, videoId, "script", { body: body("two"), sha256: sha256Hex(canonicalJson(body("two"))) });
    const unseen = async () => (await q("select content_hash from approvals where video_id = $1 and decision = 'approved' and content_hash <> $2", [videoId, viewed.hash])).rows;
    // real path: the page posts the hash it showed; the engine refuses
    const real = await decideGate(db.pool, { ...world.queues }, world.session, { videoId, gate: "script", seenHash: viewed.hash, seenVersions: versionsKey(viewed.versions), note: undefined }, "approve");
    expect(real.ok).toBe(false);
    expect(await unseen()).toEqual([]);
    // mutated path: approve whatever is live (no seen-hash check)
    const blind = await approveGate(db.pool, { videoId, gate: "script", seenHash: (await liveGateHash(db.pool, videoId, "script"))!.hash, actor: world.session as never });
    expect(blind.ok).toBe(true);
    expect((await unseen()).length).toBe(1); // the harness check fires
    void dump; void waitUntil;
  }, 120_000);
});
