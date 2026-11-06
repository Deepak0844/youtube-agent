import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { authorWebpack, SCENE_IMPORTS, SCENE_PARSER } from "../../remotion/kit/author-bundle.mjs";

// BEHAVIOURAL test of the bundler import allow-list: it really bundles scenes with the configuration render-entry.mjs uses
// (author-bundle.mjs) and checks that a hostile import FAILS the bundle (or, for webpack contexts, is never processed). Skipped when
// @remotion/bundler is not installed. Each bundle takes several seconds.
const req = createRequire(path.resolve("package.json"));
let bundle: ((o: Record<string, unknown>) => Promise<string>) | undefined;
try {
  bundle = (req("@remotion/bundler") as { bundle: typeof bundle }).bundle;
} catch {
  bundle = undefined;
}
const kitDir = path.resolve("remotion/kit");
const repoRoot = path.resolve(".");
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "abundle-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const GOOD = `import { World } from "s3k";\nexport default function Scene() { return <World focus={{ min: [0, 0, 0], max: [1, 1, 1] }} />; }\n`;

/** Bundles `source` (plus extra files in the in folder) like render-entry.mjs does; resolves with the bundle folder, rejects when webpack fails. */
async function run(name: string, source: string, extra: Record<string, string> = {}, link?: [string, string]): Promise<string> {
  const inDir = path.join(root, name, "in");
  mkdirSync(inDir, { recursive: true });
  writeFileSync(path.join(inDir, "scene.tsx"), source);
  for (const [f, text] of Object.entries(extra)) writeFileSync(path.join(inDir, f), text);
  if (link) symlinkSync(link[0], path.join(root, name, link[1]));
  return bundle!({
    entryPoint: path.join(kitDir, "s3k-author-index.tsx"),
    rootDir: repoRoot,
    outDir: path.join(root, name, "out"),
    publicDir: inDir,
    enableCaching: false,
    webpackOverride: (c: { resolve?: { modules?: string[] } }) => authorWebpack({ ...c, resolve: { ...c.resolve, modules: [...(c.resolve?.modules ?? ["node_modules"])] } }, { inDir, kitDir, repoRoot }),
  });
}
const outputOf = (dir: string): string => readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => readFileSync(path.join(dir, f), "utf8")).join("\n");
const scene = (imports: string, body = "") => `${imports}\nexport default function Scene() { ${body} return null; }\n`;

describe.runIf(bundle !== undefined)("bundler import allow-list (real webpack)", () => {
  it("control: a scene that imports only s3k bundles, and the allow-list names exactly the five modules plus the jsx runtimes", async () => {
    const out = await run("good", GOOD);
    expect(existsSync(path.join(out, "index.html"))).toBe(true);
    expect([...SCENE_IMPORTS].sort()).toEqual(["@react-three/fiber", "react", "react/jsx-dev-runtime", "react/jsx-runtime", "remotion", "s3k", "three"]);
    expect(SCENE_PARSER).toMatchObject({ commonjs: false, requireContext: false, importMetaContext: false, requireEnsure: false, requireInclude: false, requireJs: false, amd: false, worker: false, url: false, dynamicImportMode: "eager" });
  }, 180_000);

  it.each([
    ["a node built-in", scene(`import fs from "fs";`, "fs.readFileSync;")],
    ["node:fs", scene(`import { readFileSync } from "node:fs";`, "readFileSync;")],
    ["a three loader subpath", scene(`import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";`, "GLTFLoader;")],
    ["a relative file", scene(`import x from "./other";`, "x;")],
    ["a package that is installed", scene(`import { Composition } from "@remotion/renderer";`, "Composition;")],
    ["export * from a node module", `export * from "fs";\nexport default function Scene() { return null; }\n`],
    ["new URL(..., import.meta.url)", scene("", `const u = new URL("./x", import.meta.url); u;`)],
    ["new Worker(new URL(...))", scene("", `new Worker(new URL("./x.ts", import.meta.url));`)],
    ["require via a context", scene("", `(require as any)("fs");`)],
    ["a dynamic import of a literal", scene("", `import("fs");`)],
  ])("FAILS the bundle for %s", async (name, source) => {
    await expect(run(`bad-${name.replace(/\W+/g, "-")}`, source, { "other.ts": "export default 1;" })).rejects.toBeTruthy();
  }, 180_000);

  it("FAILS the bundle for a template-literal dynamic import (a webpack context) and a computed one", async () => {
    await expect(run("ctx-dyn", scene("", "const x = 'other'; import(`./${x}`);"), { "other.ts": "export default 1;" })).rejects.toThrow(/dynamic or context imports|may not import/);
    await expect(run("ctx-dyn2", scene("", "const x = String(1); import('./' + x);"), { "other.ts": "export default 1;" })).rejects.toThrow(/dynamic or context imports|may not import/);
  }, 180_000);

  it("never processes require.context or import.meta.webpackContext: no file of the in folder is pulled into the bundle", async () => {
    for (const [name, body] of [["req-ctx", "const c = (require as any).context('./', true, /\\.ts$/); c.keys();"], ["meta-ctx", "const c = (import.meta as any).webpackContext('./', { recursive: true }); c.keys();"]] as const) {
      let out: string | undefined;
      try {
        out = await run(name, scene("", body), { "secret.ts": "export const SECRET_MARKER_4242 = 'leak';" });
      } catch {
        out = undefined; // failing is the strongest outcome
      }
      if (out) expect(outputOf(out)).not.toContain("SECRET_MARKER_4242");
    }
  }, 180_000);

  it("compares issuers after realpath: a scene reached through a symlinked in folder is still held to the list", async () => {
    const real = path.join(root, "real-in");
    mkdirSync(real, { recursive: true });
    writeFileSync(path.join(real, "scene.tsx"), scene(`import fs from "fs";`, "fs.readFileSync;"));
    mkdirSync(path.join(root, "linked"), { recursive: true });
    symlinkSync(real, path.join(root, "linked", "in"));
    const inDir = path.join(root, "linked", "in");
    await expect(
      bundle!({ entryPoint: path.join(kitDir, "s3k-author-index.tsx"), rootDir: repoRoot, outDir: path.join(root, "linked", "out"), enableCaching: false, webpackOverride: (c: object) => authorWebpack(c as never, { inDir, kitDir, repoRoot }) }),
    ).rejects.toBeTruthy();
  }, 180_000);
});
