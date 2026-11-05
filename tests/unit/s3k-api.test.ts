import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildApiMd, parseManifest, sectionSizes } from "../../scripts/s3k-api";

const KIT = path.join(process.cwd(), "remotion", "kit", "s3k");
const read = (f: string) => readFileSync(path.join(KIT, f), "utf8");

/** Names the barrel exports. */
const barrelNames = (): string[] =>
  [...read("index.ts").matchAll(/export \{([^}]+)\} from/g)].flatMap((m) => m[1]!.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()!).filter(Boolean));
/** Names the manifest documents. */
const manifestNames = (): string[] => [...read("api.d.ts").matchAll(/^export (?:function|const) (\w+)/gm)].map((m) => m[1]!);

describe("s3k API manifest", () => {
  it("documents every exported name, and nothing that is not exported", () => {
    const exported = new Set(barrelNames());
    const documented = new Set(manifestNames());
    expect([...exported].filter((n) => !documented.has(n))).toEqual([]);
    expect([...documented].filter((n) => !exported.has(n))).toEqual([]);
  });
  it("has one comment line above every declaration", () => {
    const lines = read("api.d.ts").split("\n");
    lines.forEach((l, i) => { if (/^export (function|const) /.test(l)) expect(lines[i - 1]!.startsWith("/** "), `no doc line above: ${l.slice(0, 60)}`).toBe(true); });
  });
  it("API.md is up to date (run npm run s3k:api)", () => {
    expect(read("API.md")).toBe(buildApiMd());
  });
  it("keeps every section compact (under 6 KB) because it goes into a model prompt", () => {
    for (const [title, bytes] of Object.entries(sectionSizes())) expect(bytes, title).toBeLessThan(6144);
    expect(parseManifest(read("api.d.ts")).length).toBeGreaterThanOrEqual(6);
  });
});

describe("s3k import rules", () => {
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(dir, e.name)] : []));
  it("kit code only `import type`s from src/ (no runtime import)", () => {
    for (const f of files(KIT)) for (const l of readFileSync(f, "utf8").split("\n")) if (/from ["'][./]*\/src\//.test(l) || /from ["']\.\.\/\.\.\/\.\.\/src\//.test(l)) expect(l.startsWith("import type"), `${f}: ${l}`).toBe(true);
  });
  it("never uses Math.random or Date (frames must repeat)", () => {
    for (const f of files(KIT)) expect(readFileSync(f, "utf8"), f).not.toMatch(/Math\.random\(|Date\.now\(|new Date\(/);
  });
  it("registers S3kDemo lazily: three.js is not imported by the registry", () => {
    const reg = readFileSync(path.join(process.cwd(), "remotion", "kit", "registry.tsx"), "utf8");
    const imports = reg.split("\n").filter((l) => /^import .*s3k/.test(l));
    expect(imports.every((l) => l.includes("./s3k/meta"))).toBe(true);
    expect(reg).toMatch(/import\("\.\/s3k\/Demo"\)/);
    expect(read("meta.ts")).not.toMatch(/from ["']three|from ["']react/);
  });
});
