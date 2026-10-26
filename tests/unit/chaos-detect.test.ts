import { describe, expect, it } from "vitest";
import type { ChaosResult } from "../support/chaos";
import { findViolation } from "../support/chaos-detect";

// Chaos interleavings are real, so a seed that showed a violation once may not show it again (timed lease expiries,
// budget races on a shared cap). A detection must therefore hand back the very run that saw the violation.
const result = (seed: number, violations: string[]): ChaosResult => ({
  seed,
  providerCallsByKey: new Map(),
  uploaderStartsByUploadId: new Map(),
  finalStageStatuses: {},
  finalUploadStatuses: {},
  budgetConsistent: true,
  violations,
  coverage: {} as ChaosResult["coverage"],
  uploadBehaviors: {},
});

describe("findViolation", () => {
  it("returns_the_run_that_saw_the_violation_even_when_the_seed_would_not_repeat_it", async () => {
    const runs = new Map<number, number>();
    const run = async (seed: number) => {
      const n = (runs.get(seed) ?? 0) + 1;
      runs.set(seed, n);
      return result(seed, seed === 3 && n === 1 ? ["I1b logical step x:0 was called 2 times"] : []);
    };
    const hit = await findViolation(run, [1, 2, 3, 4], "I1b");
    expect(hit?.seed).toBe(3);
    expect(hit?.result.violations.filter((v) => v.startsWith("I1b"))).toHaveLength(1);
    expect(runs.get(3)).toBe(1); // never re-run: a replay would have found nothing
    expect(runs.has(4)).toBe(false); // stops at the first hit
  });

  it("returns_null_when_no_seed_shows_the_violation", async () => {
    expect(await findViolation(async (s) => result(s, ["I2 other"]), [1, 2], "I1b")).toBeNull();
  });
});
