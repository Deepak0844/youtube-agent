import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// macOS (and the render container's bind mount of it) ignores case and extension order when resolving "./name", so
// `Foo.tsx` + `foo.ts` in one folder make `import "./foo"` load the wrong file there while Linux CI stays green.
describe("tracked file names", () => {
  it("no two files in one folder share a name apart from case and extension", () => {
    const files = execFileSync("git", ["ls-files", "remotion", "src", "tests", "scripts"], { encoding: "utf8" }).split("\n").filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f));
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const f of files) {
      const dir = f.slice(0, f.lastIndexOf("/") + 1);
      const base = f.slice(dir.length).replace(/\.[^.]+$/, "").toLowerCase();
      const key = `${dir}${base}`;
      const prev = seen.get(key);
      if (prev && prev !== f) clashes.push(`${prev} <-> ${f}`);
      else seen.set(key, f);
    }
    expect(clashes).toEqual([]);
  });
});
