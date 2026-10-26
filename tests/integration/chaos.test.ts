import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { checkCoverage, checkLiveness, planFor, runChaos, type BrokenMode, type ChaosResult } from "../support/chaos";
import { findViolation } from "../support/chaos-detect";
import { withTestDb, type TestDb } from "../support/db";
import { killAllChildren } from "./helpers/stage-env";

const N = Number(process.env.CHAOS_SEEDS ?? (process.env.CI ? 60 : 200));
const ONLY = process.env.CHAOS_SEED_ONLY ? Number(process.env.CHAOS_SEED_ONLY) : null;
const SHAPE = { stages: 5, uploads: 3, steps: 3 };
const LONG = 900_000;

let db: TestDb;
beforeAll(async () => {
  db = await withTestDb();
});
afterEach(async () => {
  await killAllChildren();
});
afterAll(async () => {
  await db?.stop();
});

const seeds = (): number[] => (ONLY !== null ? [ONLY] : Array.from({ length: N }, (_, i) => i + 1));

// The healthy sweep runs once; the four invariant tests assert different views of the same results.
let sweep: Promise<Array<{ seed: number; result: ChaosResult }>> | null = null;
function healthySweep() {
  sweep ??= (async () => {
    const out: Array<{ seed: number; result: ChaosResult }> = [];
    for (const seed of seeds()) {
      const t = Date.now();
      const result = await runChaos({ seed, ...SHAPE, deps: { db } });
      if (Date.now() - t > 8000) console.error(`CHAOS SLOW seed=${seed} took ${Date.now() - t}ms`); // diagnostic for stalls
      if (result.violations.length > 0) {
        console.error(`CHAOS VIOLATION seed=${seed} (replay: CHAOS_SEED_ONLY=${seed})\nplan=${JSON.stringify(planFor(seed, SHAPE))}\n${result.violations.join("\n")}`);
      }
      out.push({ seed, result });
    }
    return out;
  })();
  return sweep;
}
const withPrefix = (all: Array<{ seed: number; result: ChaosResult }>, p: string) =>
  all.flatMap(({ seed, result }) => result.violations.filter((v) => v.startsWith(p)).map((v) => `seed ${seed}: ${v}`));

// Runs seeds until the harness reports a violation with the given prefix.
// Returns the run that saw it: a seed is NOT guaranteed to repeat a violation (real interleavings), so never replay it.
const detect = (mode: BrokenMode, prefix: string) =>
  findViolation((seed) => runChaos({ seed, ...SHAPE, brokenMode: mode, deps: { db } }), seeds(), prefix);

describe("chaos", () => {
  it("invariant_no_call_key_is_called_twice_over_N_seeded_runs", async () => {
    const all = await healthySweep();
    for (const { result } of all) for (const n of result.providerCallsByKey.values()) expect(n).toBeLessThanOrEqual(1);
    expect(withPrefix(all, "I1")).toEqual([]);
    expect(all.flatMap((a) => a.result.violations.filter((v) => v.startsWith("unexpected")))).toEqual([]);
    expect(all.some((a) => a.result.providerCallsByKey.size > 0)).toBe(true);
  }, LONG);

  it("invariant_no_upload_starts_twice", async () => {
    const all = await healthySweep();
    for (const { result } of all) for (const n of result.uploaderStartsByUploadId.values()) expect(n).toBeLessThanOrEqual(1);
    expect(withPrefix(all, "I2")).toEqual([]);
  }, LONG);

  it("every_stage_ends_in_a_terminal_or_needs_decision_status", async () => {
    const all = await healthySweep();
    const ok = new Set(["succeeded", "failed", "needs_decision", "cancelled"]);
    for (const { seed, result } of all) {
      for (const [k, s] of Object.entries(result.finalStageStatuses)) expect(ok.has(s), `seed ${seed} ${k}=${s}`).toBe(true);
      for (const [k, s] of Object.entries(result.finalUploadStatuses)) expect(s === "uploading", `seed ${seed} ${k}=${s}`).toBe(false);
    }
    expect(withPrefix(all, "I3")).toEqual([]);
    expect(withPrefix(all, "I5")).toEqual([]);
  }, LONG);

  it("budgets_stay_consistent", async () => {
    const all = await healthySweep();
    expect(all.filter((a) => !a.result.budgetConsistent).map((a) => a.seed)).toEqual([]);
    expect(withPrefix(all, "I4")).toEqual([]);
  }, LONG);

  it("harness_detects_a_deliberately_broken_call_key", async () => {
    expect(await detect("broken_call_key", "I1b")).not.toBeNull();
  }, LONG);

  // A fresh call key per attempt, end to end (reserve AND the key the provider receives), is the realistic bug: a real
  // provider would charge twice. The key-based check I1 trusts the product's own key, so it sees every key once and
  // MISSES it. Only the harness's own logical-step record (stage id, step index) catches it (I1b).
  it("harness_detects_fresh_key_per_attempt_via_logical_step_check", async () => {
    const hit = await detect("broken_call_key", "I1b");
    expect(hit).not.toBeNull();
    const r = hit!.result; // the run that reported I1b; a replay of the same seed may legitimately differ
    expect(r.violations.filter((v) => v.startsWith("I1b")).length).toBeGreaterThan(0);
    expect(r.violations.filter((v) => v.startsWith("I1 "))).toEqual([]); // I1 alone would have missed it
    expect([...r.providerCallsByKey.values()].every((n) => n === 1)).toBe(true);
  }, LONG);

  it("harness_detects_a_stalled_upload_that_is_automatically_retried", async () => {
    let hits = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const r = await runChaos({ seed, ...SHAPE, brokenMode: "broken_stalled_autoretry", deps: { db } });
      if (r.violations.some((v) => v.startsWith("I2"))) hits++;
    }
    expect(hits).toBeGreaterThanOrEqual(10);
  }, LONG);

  it("harness_liveness_and_fault_coverage_over_the_sweep", async () => {
    const all = (await healthySweep()).map((a) => a.result);
    expect(checkLiveness(all)).toEqual([]);
    if (ONLY === null) expect(checkCoverage(all, N)).toEqual([]);
  }, LONG);

  // The checks must be able to fail: with the commit never happening, nothing succeeds and liveness must say so.
  it("harness_liveness_check_fails_when_commit_never_happens", async () => {
    const rs: ChaosResult[] = [];
    for (let seed = 1; seed <= 6; seed++) rs.push(await runChaos({ seed, ...SHAPE, brokenMode: "no_commit", deps: { db } }));
    expect(checkLiveness(rs).some((v) => v.includes("stages succeeded"))).toBe(true);
  }, LONG);

  it("harness_detects_a_deliberately_broken_requeue", async () => {
    expect(await detect("broken_requeue", "I5")).not.toBeNull();
  }, LONG);

  it("harness_detects_a_deliberately_broken_upload_door", async () => {
    expect(await detect("broken_upload_door", "I2")).not.toBeNull();
  }, LONG);

  it("same_seed_same_fault_plan", () => {
    for (const seed of [1, 2, 25, 50, 199]) expect(planFor(seed, SHAPE)).toEqual(planFor(seed, SHAPE));
    expect(planFor(1, SHAPE)).not.toEqual(planFor(2, SHAPE));
    // marker rotation: every 12th seed is a real SIGKILL seed, markers rotate, so the first 60 seeds cover all four
    const markers = [12, 24, 36, 48, 60].map((s) => planFor(s, SHAPE).realKill?.marker);
    expect(markers).toEqual(["CLAIMED", "INTENT_RESERVED", "PROVIDER_RETURNED", "SETTLED", "CLAIMED"]);
    expect(planFor(13, SHAPE).realKill).toBeNull();
  });
});
