import type { ChaosResult } from "./chaos";

// Runs seeds in order until one reports a violation starting with `prefix`, and returns THAT run. Callers must assert on
// the returned result and never replay the seed: interleavings are real (timed lease expiries, races for a shared budget
// cap), so a replay is not guaranteed to repeat the violation.
export async function findViolation(
  run: (seed: number) => Promise<ChaosResult>,
  seeds: number[],
  prefix: string,
): Promise<{ seed: number; result: ChaosResult } | null> {
  for (const seed of seeds) {
    const result = await run(seed);
    if (result.violations.some((v) => v.startsWith(prefix))) return { seed, result };
  }
  return null;
}
