import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Every typed safeFetch call must say which local services it may reach (S1). The type already requires it; this guards
// against casts and spreads that would hide a missing list from the compiler.
const TYPED = /mode:\s*["']typed["']/g;

/** Source text of each object literal that contains `mode: "typed"` and lacks `localServices`. */
export function typedCallsWithoutList(src: string): string[] {
  const bad: string[] = [];
  for (const m of src.matchAll(TYPED)) {
    let start = m.index!;
    for (let depth = 0; start > 0; start--) {
      const c = src[start]!;
      if (c === "}") depth++;
      else if (c === "{" && depth-- === 0) break;
    }
    let end = m.index!;
    for (let depth = 0; end < src.length; end++) {
      const c = src[end]!;
      if (c === "{") depth++;
      else if (c === "}" && depth-- === 0) break;
    }
    const literal = src.slice(start, end + 1);
    if (!/\blocalServices\b/.test(literal)) bad.push(literal);
  }
  return bad;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(p) ? [p] : [];
  });
}

describe("typed safeFetch callers", () => {
  it("the checker itself sees a missing list", () => {
    expect(typedCallsWithoutList('f(u, undefined, { mode: "typed", ownServices: own })')).toHaveLength(1);
    expect(typedCallsWithoutList('f(u, undefined, { mode: "typed", localServices: [] })')).toHaveLength(0);
    expect(typedCallsWithoutList('f(u, undefined, { ownServices: own, mode: "typed",\n timeoutMs: 1, localServices: x })')).toHaveLength(0);
  });
  it("every typed call in src passes localServices explicitly", () => {
    const offenders = walk("src")
      .map((f) => ({ f, bad: typedCallsWithoutList(readFileSync(f, "utf8")) }))
      .filter((x) => x.bad.length > 0)
      .map((x) => x.f);
    expect(offenders).toEqual([]);
  });
});
