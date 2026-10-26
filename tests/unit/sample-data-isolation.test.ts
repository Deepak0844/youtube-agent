import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const ALLOWED = [/^src\/ui\/sample\//, /^src\/app\/\(app\)\/dev\//, /^tests\//];
const IMPORT = /(?:from|import\s*\(|import)\s*["'](?:@\/ui\/sample|(?:\.{1,2}\/)+(?:[\w-]+\/)*sample)(?:\/[^"']*)?["']/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|mts|mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

describe("sample data isolation", () => {
  it("only sample, dev routes and tests import the sample data", () => {
    const offenders: string[] = [];
    for (const dir of ["src", "scripts", "infra", "remotion"]) {
      const full = join(root, dir);
      for (const f of walk(full)) {
        const rel = relative(root, f).split("\\").join("/");
        if (ALLOWED.some((re) => re.test(rel))) continue;
        if (IMPORT.test(readFileSync(f, "utf8"))) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the detector flags a bad import", () => {
    expect(IMPORT.test('import { sample } from "@/ui/sample/data";')).toBe(true);
    expect(IMPORT.test('import x from "../ui/sample/data";')).toBe(true);
    expect(IMPORT.test('import x from "@/ui/domain/gate";')).toBe(false);
  });
});
