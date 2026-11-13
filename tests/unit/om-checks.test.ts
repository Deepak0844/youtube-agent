import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateComposition } from "@/server/engine/om-checks/composition";

// OpenMontage parity, Phase B: the TypeScript ports of OpenMontage's pre-render checks give the same answers as its Python on
// golden cases (tests/fixtures/openmontage/goldens, made once by running the Python in the upstream clone).

const GOLD = "tests/fixtures/openmontage/goldens";
const goldens = (prefix: string) =>
  readdirSync(GOLD).filter((f) => f.startsWith(prefix)).map((f) => [f, JSON.parse(readFileSync(path.join(GOLD, f), "utf8"))] as const);

describe("composition validator port", () => {
  it.each(goldens("composition-"))("matches_openmontage_on %s", (_name, g) => {
    const files = g.files as Record<string, number | null>;
    const r = validateComposition(g.input, { exists: (n) => Object.hasOwn(files, n), durationS: (n) => files[n] ?? null });
    expect({ valid: r.ok, errors: r.errors, warnings: r.warnings }).toEqual(g.expected);
  });

  it("has_the_cases", () => {
    expect(goldens("composition-").length).toBe(7);
  });
});
