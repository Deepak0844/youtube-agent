// The TypeScript compiler run for ONE AI-written 3D scene (layer 2). Runs in a worker thread (scene3d-typecheck.ts starts it with a heap cap and
// terminates it at the deadline), so a pathological type can never block the worker's event loop. In-memory files only, nothing is emitted.
// Only react, remotion, three, @react-three/fiber and s3k resolve from the scene (s3k is typed by the text it is given); no Node types.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import ts from "typescript";

const MAX_PROBLEMS = 12;
const NODE_MODULES = path.dirname(path.dirname(createRequire(import.meta.url).resolve("typescript/package.json")));
const DIR = path.join(path.dirname(NODE_MODULES), "__s3k_scene__"); // a virtual folder beside node_modules, so the allowed modules resolve from the app's own install
const SCENE = path.join(DIR, "scene.tsx");
const AMBIENT = path.join(DIR, "ambient.ts"); // loads react-three-fiber's JSX element types (<mesh>, <group> ...) even when the scene does not import it
const S3K_DTS = path.join(DIR, "s3k.d.ts");
const ALLOWED = new Set(["react", "react/jsx-runtime", "remotion", "three", "@react-three/fiber"]);
const OPTIONS = {
  strict: true, noUncheckedIndexedAccess: true, noEmit: true, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ES2022, lib: ["lib.es2022.d.ts", "lib.dom.d.ts"], types: [], skipLibCheck: true, isolatedModules: true, esModuleInterop: true, allowJs: false,
};
const libCache = new Map();

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}
const closest = (name, from) => [...from].map((n) => [n, distance(name.toLowerCase(), n.toLowerCase())]).sort((x, y) => x[1] - y[1]).slice(0, 4).map((x) => x[0]);
const echo = (t, n = 30) => String(t).replace(/[^\x20-\x7e]/g, "?").slice(0, n);
/** No absolute path, home folder or import("...") fragment leaves this file: the sentences go to a model and to logs. */
const scrub = (t) => String(t).replace(/import\("[^"]*"\)/g, "import(<module>)").replace(/(?:[A-Za-z]:)?[\\/][^\s"'`)\]]+/g, "<path>");

function sentence(d, sf, pools) {
  const line = d.file && d.start !== undefined && d.file === sf ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : "?";
  const msg = scrub(ts.flattenDiagnosticMessageText(d.messageText, " "));
  const member = /'"?([^'"]+)"?' has no exported member(?: named)? '([^']+)'/.exec(msg);
  if (member) {
    const [, mod, name] = member;
    const pool = pools[mod] ?? [];
    return `line ${line}: import: ${mod} has no "${echo(name)}"${pool.length ? `; the closest allowed names are ${closest(name, pool).join(", ")}` : ""}.`;
  }
  const missing = /Cannot find name '([^']+)'/.exec(msg);
  if (missing) return `line ${line}: name: "${echo(missing[1])}" is not defined; import it from s3k or three, or declare it.`;
  const nomod = /Cannot find module '([^']+)'/.exec(msg);
  if (nomod) return `line ${line}: import: the module "${echo(nomod[1])}" is not available; scenes may import only react, remotion, three, @react-three/fiber and s3k.`;
  return `line ${line}: type error: ${msg.replace(/\s+/g, " ").replace(/[^\x20-\x7e]/g, "?").slice(0, 170)}`;
}

/** { ok, problems, sha256, fatal? }. `input`: { source, dts (the s3k declaration text), pools: { s3k: names, three: names }, budgetMs }. Never throws except on a compiler crash. */
export function typeCheckCore({ source, dts, pools, budgetMs }) {
  const sha256 = createHash("sha256").update(source).digest("hex");
  const deadline = Date.now() + budgetMs;
  const files = { [SCENE]: source, [AMBIENT]: 'import type {} from "@react-three/fiber";\nexport {};\n', [S3K_DTS]: dts };
  const host = ts.createCompilerHost(OPTIONS, true);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (f, lang, onError, create) => {
    const v = files[f];
    if (v !== undefined) return ts.createSourceFile(f, v, lang, true, f.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
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
  const sf = program.getSourceFile(SCENE);
  if (!sf) return { ok: false, fatal: true, sha256, problems: ["type-check: the file could not be read by the type-checker."] };
  const token = {
    isCancellationRequested: () => Date.now() > deadline,
    throwIfCancellationRequested: () => {
      if (Date.now() > deadline) throw new ts.OperationCanceledException();
    },
  };
  try {
    const global = [...program.getGlobalDiagnostics(), ...program.getOptionsDiagnostics()];
    if (global.length > 0) return { ok: false, fatal: true, sha256, problems: [`type-check: the compiler reported a setup problem (${echo(ts.flattenDiagnosticMessageText(global[0].messageText, " "), 80)}).`] };
    const diags = [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf, token)];
    const problems = [...new Set(diags.slice(0, MAX_PROBLEMS * 2).map((d) => sentence(d, sf, pools)))].slice(0, MAX_PROBLEMS);
    return { ok: problems.length === 0, problems, sha256 };
  } catch (e) {
    if (e instanceof ts.OperationCanceledException) return { ok: false, fatal: true, sha256, problems: [`type-check: the type-check took longer than ${Math.round(budgetMs / 1000)} s; write simpler, smaller code.`] };
    throw e;
  }
}

// Thread entry: workerData { source, dts, pools, budgetMs }; posts one result message.
if (!isMainThread && parentPort && workerData?.kind === "scene3d-typecheck") {
  let result;
  try {
    result = typeCheckCore(workerData);
  } catch {
    result = { ok: false, fatal: true, sha256: createHash("sha256").update(String(workerData.source)).digest("hex"), problems: ["type-check: the type-checker failed on this file."] };
  }
  parentPort.postMessage(result);
}
