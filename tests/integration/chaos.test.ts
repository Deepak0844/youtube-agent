import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { planFor, runChaos, type BrokenMode, type ChaosResult } from "../support/chaos";
import { withTestDb, type TestDb } from "../support/db";
import { killAllChildren } from "./helpers/stage-env";

const N = Number(process.env.CHAOS_SEEDS ?? 200);
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
      const result = await runChaos({ seed, ...SHAPE, deps: { db } });
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
async function detect(mode: BrokenMode, prefix: string): Promise<{ seed: number; count: number } | null> {
  for (const seed of seeds()) {
    const r = await runChaos({ seed, ...SHAPE, brokenMode: mode, deps: { db } });
    const hits = r.violations.filter((v) => v.startsWith(prefix));
    if (hits.length > 0) return { seed, count: hits.length };
  }
  return null;
}

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
    expect(await detect("broken_call_key", "I1")).not.toBeNull();
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
    expect(planFor(25, SHAPE).realKill).not.toBeNull();
    expect(planFor(26, SHAPE).realKill).toBeNull();
  });
});
