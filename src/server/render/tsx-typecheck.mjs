// Type-checks ONE model-written Remotion TSX file with the TypeScript compiler API (ADR 0009 guardrail 1: webpack only
// transpiles, so a missing import or a wrong prop would otherwise surface only at render time).
// Runs in a worker thread of the worker process (tsx-render.ts starts it with a timeout and a heap cap and terminates it);
// never in the render container. The scene is an in-memory file; nothing is written or emitted.
// Only the allowed modules resolve from the scene (react, react/jsx-runtime, remotion, @remotion/shapes, @remotion/paths);
// no @types are pulled in automatically and Node's types never resolve, so `process`, `require`, `Buffer` are unknown.
import { createRequire } from "node:module";
import path from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import ts from "typescript";

const NODE_MODULES = path.dirname(path.dirname(createRequire(import.meta.url).resolve("typescript/package.json")));
// A virtual path beside node_modules, so the allowed modules resolve from the app's own install.
const SCENE = path.join(path.dirname(NODE_MODULES), "__tsx_scene__", "video.tsx");
const ALLOWED = new Set(["react", "react/jsx-runtime", "remotion", "@remotion/shapes", "@remotion/paths"]);
const MAX_PROBLEMS = 10;
const OPTIONS = {
  strict: true,
  noEmit: true,
  jsx: ts.JsxEmit.ReactJSX,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ES2022,
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
  types: [],
  skipLibCheck: true,
  isolatedModules: true,
  esModuleInterop: true,
  allowJs: false,
  noLib: false,
};

/** { ok, problems } with "line N: message" problems (raw compiler text; the caller caps and scrubs it). Throws only on a compiler crash. */
export function typeCheckTsx(source) {
  const host = ts.createCompilerHost(OPTIONS, true);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  host.getSourceFile = (f, lang, onError, create) => (f === SCENE ? ts.createSourceFile(f, source, lang, true, ts.ScriptKind.TSX) : getSourceFile(f, lang, onError, create));
  host.fileExists = (f) => f === SCENE || fileExists(f);
  host.readFile = (f) => (f === SCENE ? source : readFile(f));
  host.writeFile = () => {};
  host.resolveModuleNameLiterals = (literals, containing, redirected, options) =>
    literals.map((l) => (containing === SCENE && !ALLOWED.has(l.text) ? { resolvedModule: undefined } : ts.resolveModuleName(l.text, containing, options, host, undefined, redirected)));
  host.resolveTypeReferenceDirectiveReferences = (refs, containing, redirected, options) =>
    refs.map((r) => {
      const name = (typeof r === "string" ? r : r.fileName).toLowerCase();
      if (containing === SCENE || name === "node" || name.startsWith("node/")) return { resolvedTypeReferenceDirective: undefined };
      return ts.resolveTypeReferenceDirective(name, containing, options, host, redirected);
    });

  const program = ts.createProgram({ rootNames: [SCENE], options: OPTIONS, host });
  const sf = program.getSourceFile(SCENE);
  if (!sf) return { ok: false, problems: ["The file could not be read by the type-checker."] };
  const diags = [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)];
  const problems = diags.slice(0, MAX_PROBLEMS).map((d) => {
    const line = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : "?";
    return `line ${line}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
  });
  return { ok: problems.length === 0, problems };
}

// Thread entry (tsx-render.ts): workerData { kind: "tsx-typecheck", source }; posts one { ok, problems } message.
if (!isMainThread && parentPort && workerData?.kind === "tsx-typecheck") {
  let result;
  try {
    result = typeCheckTsx(String(workerData.source));
  } catch {
    result = { ok: false, problems: ["The type-checker failed on this file."] };
  }
  parentPort.postMessage(result);
}
