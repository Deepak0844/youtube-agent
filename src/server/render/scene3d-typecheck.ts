import { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";
import { S3K_ALLOWED, THREE_ALLOWED } from "@/server/core/scene3d-code-check";
import { S3K_API_DTS } from "@/server/core/s3k-kit-dts";
import { sha256Hex } from "@/server/core/content-hash";
import { echo } from "@/server/core/tsx-check";

// Type-check of ONE AI-written 3D scene against the kit's declarations (api.d.ts = module "s3k", with its three and react types) with
// the TypeScript compiler API, IN-PROCESS (no worker, no emit, nothing written). Runs after checkScene3dCode has passed. Only the five
// allowed modules resolve from the scene; Node's types never load, so `process` or `require` are unknown names. A 15 s budget stops a
// slow check (a cancellation token the compiler polls). Every error becomes one plain sentence that names the symbol and, for a wrong
// import name, the closest allowed ones, so the model can fix it in one retry.

export const SCENE_TYPECHECK_BUDGET_MS = 15_000;
const MAX_PROBLEMS = 12;
const NODE_MODULES = path.dirname(path.dirname(createRequire(import.meta.url).resolve("typescript/package.json")));
const DIR = path.join(path.dirname(NODE_MODULES), "__s3k_scene__"); // a virtual folder beside node_modules, so the allowed modules resolve from the app's own install
const SCENE = path.join(DIR, "scene.tsx");
const AMBIENT = path.join(DIR, "ambient.ts"); // loads react-three-fiber's JSX element types (<mesh>, <group> ...) even when the scene does not import it
const S3K_DTS = path.join(DIR, "s3k.d.ts");
const ALLOWED = new Set(["react", "react/jsx-runtime", "remotion", "three", "@react-three/fiber"]);
const OPTIONS: ts.CompilerOptions = {
  strict: true, noUncheckedIndexedAccess: true, noEmit: true, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ES2022, lib: ["lib.es2022.d.ts", "lib.dom.d.ts"], types: [], skipLibCheck: true, isolatedModules: true, esModuleInterop: true, allowJs: false,
};
const libCache = new Map<string, ts.SourceFile>();
const virtual = (source: string): Record<string, string> => ({
  [SCENE]: source,
  [AMBIENT]: 'import type {} from "@react-three/fiber";\nexport {};\n',
  [S3K_DTS]: S3K_API_DTS,
});

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length]!;
}
const closest = (name: string, from: readonly string[]): string[] => [...from].map((n) => [n, distance(name.toLowerCase(), n.toLowerCase())] as const).sort((x, y) => x[1] - y[1]).slice(0, 4).map((x) => x[0]);

/** One compiler diagnostic as a plain sentence. */
function sentence(d: ts.Diagnostic, sf: ts.SourceFile | undefined): string {
  const line = d.file && d.start !== undefined && d.file === sf ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : "?";
  const msg = ts.flattenDiagnosticMessageText(d.messageText, " ");
  const member = /'"?([^'"]+)"?' has no exported member(?: named)? '([^']+)'/.exec(msg);
  if (member) {
    const [, mod, name] = member as unknown as [string, string, string];
    const pool = mod === "s3k" ? S3K_ALLOWED : mod === "three" ? THREE_ALLOWED : [];
    return `line ${line}: import: ${mod} has no "${echo(name)}"${pool.length ? `; the closest allowed names are ${closest(name, pool).join(", ")}` : ""}.`;
  }
  const missing = /Cannot find name '([^']+)'/.exec(msg);
  if (missing) return `line ${line}: name: "${echo(missing[1]!)}" is not defined; import it from s3k or three, or declare it.`;
  const nomod = /Cannot find module '([^']+)'/.exec(msg);
  if (nomod) return `line ${line}: import: the module "${echo(nomod[1]!)}" is not available; scenes may import only react, remotion, three, @react-three/fiber and s3k.`;
  return `line ${line}: type error: ${msg.replace(/\s+/g, " ").replace(/[^\x20-\x7e]/g, "?").slice(0, 170)}`;
}

export interface SceneTypeResult {
  ok: boolean;
  problems: string[];
  /** sha256 of the exact source text that was checked: the host compares it with the bytes it is about to use. */
  sha256: string;
  /** true when the check itself could not finish (timeout, crash, unreadable file): never a hint for the model, always a stop. */
  fatal?: boolean;
}

/** Type-checks one scene source. Never throws. `budgetMs` is for tests. */
export function typeCheckScene3d(source: string, budgetMs: number = SCENE_TYPECHECK_BUDGET_MS): SceneTypeResult {
  const sha256 = sha256Hex(source);
  const started = Date.now();
  const deadline = started + budgetMs;
  const slow = (): SceneTypeResult => ({ ok: false, fatal: true, sha256, problems: [`type-check: the type-check took longer than ${Math.round(budgetMs / 1000)} s; write simpler, smaller code.`] });
  try {
    const files = virtual(source);
    const host = ts.createCompilerHost(OPTIONS, true);
    const read = host.getSourceFile.bind(host);
    host.getSourceFile = (f, lang, onError, create) => {
      const v = files[f];
      if (v !== undefined) return ts.createSourceFile(f, v, lang, true, f.endsWith(".tsx") ? ts.ScriptKind.TSX : f.endsWith(".d.ts") ? ts.ScriptKind.TS : ts.ScriptKind.TS);
      let sf = libCache.get(f);
      if (!sf) {
        sf = read(f, lang, onError, create);
        if (sf) libCache.set(f, sf);
      }
      return sf;
    };
    host.fileExists = (f) => f in files || ts.sys.fileExists(f);
    host.readFile = (f) => files[f] ?? ts.sys.readFile(f);
    host.writeFile = () => undefined;
    host.resolveModuleNameLiterals = (literals, containing, redirected, options) =>
      literals.map((l) => {
        if (containing === SCENE) {
          if (l.text === "s3k") return { resolvedModule: { resolvedFileName: S3K_DTS, extension: ts.Extension.Dts, isExternalLibraryImport: false } };
          if (!ALLOWED.has(l.text)) return { resolvedModule: undefined };
        }
        return ts.resolveModuleName(l.text, containing, options, host, undefined, redirected);
      });
    host.resolveTypeReferenceDirectiveReferences = (refs, containing, redirected, options) =>
      refs.map((r) => {
        const name = (typeof r === "string" ? r : r.fileName).toLowerCase();
        if (containing === SCENE || name === "node" || name.startsWith("node/")) return { resolvedTypeReferenceDirective: undefined };
        return ts.resolveTypeReferenceDirective(name, containing, options, host, redirected);
      });
    const program = ts.createProgram({ rootNames: [SCENE, AMBIENT], options: OPTIONS, host });
    if (Date.now() > deadline) return slow();
    const sf = program.getSourceFile(SCENE);
    if (!sf) return { ok: false, fatal: true, sha256, problems: ["type-check: the file could not be read by the type-checker."] };
    const token: ts.CancellationToken = {
      isCancellationRequested: () => Date.now() > deadline,
      throwIfCancellationRequested: () => { if (Date.now() > deadline) throw new ts.OperationCanceledException(); },
    };
    const diags = [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf, token)];
    const problems = [...new Set(diags.slice(0, MAX_PROBLEMS * 2).map((d) => sentence(d, sf)))].slice(0, MAX_PROBLEMS);
    return { ok: problems.length === 0, problems, sha256 };
  } catch (e) {
    if (e instanceof ts.OperationCanceledException) return slow();
    return { ok: false, fatal: true, sha256, problems: ["type-check: the type-checker failed on this file; write simpler code."] };
  }
}
