import ts from "typescript";

// SECURITY CONTROL (first line, ADR 0009): a static check of ONE model-written Remotion TSX file before it is type-checked,
// bundled or rendered. It works on the TypeScript AST, not on regexes over the code. It is deliberately strict: an
// allow-list of imports, no network/DOM/timer/clock APIs, no dynamic code, bounded loops, safe JSX only.
// It is NOT the security boundary: JavaScript is too dynamic for a static check to be complete (a value built at run time
// can still reach a lookup). The boundary is the render container (tsx-sandbox.ts: no network, read-only, non-root, short
// timeout); preflight frames (tsx-preflight.ts) catch blank or frozen output. Pure, never throws, linear in input size;
// the input is capped before parsing.

export const TSX_MAX_BYTES = 24 * 1024;
export const TSX_MAX_FRAMES = 2700; // 90 s at 30 fps
export const TSX_META = { fps: 30, width: 1080, height: 1920 } as const;
const MAX_PROBLEMS = 20;
const MAX_ECHO = 30;
const MAX_DEPTH = 200;
const MAX_LOOP_BOUND = 10_000;
const MAX_LOOP_NEST = 2;
const MAX_LOOP_PRODUCT = 100_000;
const MAX_PLUS_TERMS = 1000;

/** Every named value import the file may use, per module. Type-only imports from these modules are always fine. */
export const TSX_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  react: ["useMemo", "Fragment"],
  remotion: [
    "AbsoluteFill", "Sequence", "Series", "Loop", "Freeze", "Img", "staticFile", "useCurrentFrame", "useVideoConfig",
    "interpolate", "interpolateColors", "spring", "Easing", "random",
  ],
  // Installed in the render image (infra/Dockerfile.render), same version as remotion.
  "@remotion/shapes": ["Circle", "Ellipse", "Rect", "Triangle", "Star", "Pie"],
  "@remotion/paths": ["evolvePath", "getLength", "getPointAtLength", "getTangentAtLength"],
};
const REACT_DEFAULT = "React"; // `import React from "react"` is allowed; only React.useMemo / React.Fragment may be used on it

// Names that may not be referenced at all (globals that reach the network, the page, timers, dynamic code or the clock).
const FORBIDDEN_GLOBALS = new Set([
  "eval", "Function", "require", "module", "exports", "process", "Buffer", "global", "globalThis", "window", "self", "top",
  "parent", "frames", "opener", "document", "navigator", "location", "history", "fetch", "XMLHttpRequest", "WebSocket",
  "EventSource", "Worker", "SharedWorker", "ServiceWorker", "importScripts", "postMessage", "BroadcastChannel",
  "MessageChannel", "localStorage", "sessionStorage", "indexedDB", "caches", "cookieStore", "customElements", "setTimeout",
  "setInterval", "setImmediate", "requestAnimationFrame", "requestIdleCallback", "queueMicrotask", "Date", "performance",
  "crypto", "Reflect", "Proxy", "WebAssembly", "Atomics", "SharedArrayBuffer", "atob", "btoa", "unescape", "escape",
  "decodeURI", "decodeURIComponent", "Image", "Audio", "Request", "Response", "Headers", "URL", "Blob", "FileReader",
  "alert", "open", "close", "__dirname", "__filename", "__webpack_require__", "__non_webpack_require__", "arguments",
  "delayRender", "continueRender", "cancelRender", "RTCPeerConnection", "webkitRTCPeerConnection", "WebTransport",
  "fetchLater", "Notification", "Symbol", "Intl", "RegExp",
]);
// Refused in every position, even as a local name or a member name: no shadowing story makes these useful.
const HARD_GLOBALS = new Set([
  "eval", "arguments", "Function", "globalThis", "window", "self", "Reflect", "Proxy", "Symbol", "Intl", "RegExp", "require",
  "process", "document", "fetch", "XMLHttpRequest", "WebSocket", "importScripts", "__webpack_require__",
  "__non_webpack_require__", "WebAssembly", "SharedArrayBuffer", "Atomics",
]);
// Member names that may not be read or written on anything (prototype walking, DOM escape hatches, the clock, React
// element forgery, unbounded string growth). Matched case-insensitively.
const FORBIDDEN_MEMBERS = lower([
  "constructor", "prototype", "__proto__", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__",
  "getPrototypeOf", "setPrototypeOf", "defineProperty", "defineProperties", "getOwnPropertyDescriptor",
  "getOwnPropertyDescriptors", "fromCharCode", "fromCodePoint", "raw", "innerHTML", "outerHTML", "insertAdjacentHTML",
  "srcdoc", "contentWindow", "contentDocument", "ownerDocument", "defaultView", "getRootNode", "sendBeacon", "cookie",
  "createElement", "cloneElement", "createPortal", "dangerouslySetInnerHTML", "now",
  "eval", "Function", "fetch", "require", "process", "window", "document", "globalThis", "importScripts", "self", "$$typeof",
  "repeat", "callee", "caller",
]);
// Whole string values refused anywhere (case-insensitive): names only useful to rebuild a forbidden lookup. Ordinary
// words ("process", "window", "Date") stay usable as caption text; computed keys must be numbers anyway (checkKey).
const STRING_BANNED = lower([
  "constructor", "prototype", "__proto__", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__",
  "globalThis", "eval", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "sendBeacon", "innerHTML", "outerHTML",
  "insertAdjacentHTML", "srcdoc", "contentWindow", "contentDocument", "ownerDocument", "defaultView", "createElement",
  "dangerouslySetInnerHTML", "getPrototypeOf", "setPrototypeOf", "defineProperty", "getOwnPropertyDescriptor", "fromCharCode",
  "setTimeout", "setInterval", "requestAnimationFrame", "localStorage", "sessionStorage", "indexedDB", "WebAssembly",
  "SharedArrayBuffer", "__webpack_require__", "__non_webpack_require__", "$$typeof",
]);
// Lower-case JSX tags never allowed (script/network/embedding, CSS injection, time-based animation, <img> instead of <Img>).
const FORBIDDEN_TAGS = new Set([
  "script", "iframe", "frame", "frameset", "object", "embed", "applet", "portal", "link", "style", "meta", "base", "form",
  "img", "video", "audio", "source", "track", "picture", "foreignobject", "animate", "animatemotion", "animatetransform",
  "set", "a", "noscript", "template", "slot", "dialog", "marquee", "canvas",
]);
const URL_ATTRS = new Set(["src", "href", "xlinkhref", "srcset", "poster", "action", "formaction", "data", "background", "ping", "manifest", "codebase"]);
// Built-in objects that may only be used as X.name, X(...), new X(...) or `instanceof X`: never aliased, passed around,
// destructured or shadowed (so `Math.floor` really is Math.floor).
const GLOBAL_OBJECTS = new Set(["Math", "Object", "Array", "String", "Number", "Boolean", "JSON", "Promise", "Error", "Map", "Set", "WeakMap", "WeakSet"]);
const AS_ARGUMENT_OK = new Set(["Boolean", "Number", "String"]); // .filter(Boolean), .map(String)
const NEW_OK = new Set(["Map", "Set", "Array"]);
const NO_SHADOW = new Set([...GLOBAL_OBJECTS, "undefined", "NaN", "Infinity"]);
// Math functions that always return a number: Math.floor(x) is a safe computed key.
const MATH_NUMERIC = new Set(["floor", "ceil", "round", "trunc", "abs", "min", "max", "sign"]);
const ARITH = new Set([
  ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken, ts.SyntaxKind.AmpersandToken, ts.SyntaxKind.BarToken, ts.SyntaxKind.CaretToken,
  ts.SyntaxKind.LessThanLessThanToken, ts.SyntaxKind.GreaterThanGreaterThanToken, ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
]);
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const JSX_IDENT = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;
const STATIC_PATH = /^[A-Za-z0-9_-][A-Za-z0-9_./-]{0,127}$/;
const COMMENT_DIRECTIVES = ["@ts-", "@jsx", "<reference", "<amd-", "sourcemappingurl", "sourceurl", "webpack", "eslint-disable"];
const TIMERS = new Set(["setTimeout", "setInterval", "requestAnimationFrame", "requestIdleCallback", "setImmediate", "queueMicrotask"]);
const NETWORK = new Set(["fetch", "XMLHttpRequest", "WebSocket", "EventSource"]);

function lower(names: string[]): Set<string> {
  return new Set(names.map((n) => n.toLowerCase()));
}

/** True for a staticFile() name: plain relative path of [A-Za-z0-9._/-], no '.'/'..' segment, no leading '/' or '.'. */
export function isStaticName(name: string): boolean {
  return STATIC_PATH.test(name) && !name.split("/").some((s) => s === ".." || s === ".");
}

export interface TsxCheckResult {
  ok: boolean;
  problems: string[];
}

/** Statically checks one AI-written Remotion TSX file. Never throws; the problems are short, plain and safe to echo back. */
export function checkTsx(source: unknown): TsxCheckResult {
  const problems: string[] = [];
  try {
    if (typeof source !== "string") return fail(["The file must be text."]);
    if (source.length > TSX_MAX_BYTES || Buffer.byteLength(source, "utf8") > TSX_MAX_BYTES) return fail([`The file is bigger than ${TSX_MAX_BYTES / 1024} KB.`]);
    if (source.trim() === "") return fail(["The file is empty."]);
    checkChars(source, problems);
    if (problems.length > 0) return fail(problems);
    walk(source, problems);
  } catch {
    problems.push("The file could not be checked.");
  }
  return problems.length === 0 ? { ok: true, problems } : fail(problems);
}

/** meta.durationInFrames of a file that passed checkTsx (undefined when there is none). Never throws. */
export function tsxDuration(source: string): number | undefined {
  try {
    const sf = ts.createSourceFile("scene.tsx", source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
    for (const st of sf.statements) {
      if (!ts.isVariableStatement(st)) continue;
      for (const d of st.declarationList.declarations) {
        let init = d.initializer;
        while (init && (ts.isAsExpression(init) || ts.isSatisfiesExpression(init) || ts.isParenthesizedExpression(init))) init = init.expression;
        if (!ts.isIdentifier(d.name) || d.name.text !== "meta" || !init || !ts.isObjectLiteralExpression(init)) continue;
        for (const p of init.properties) {
          if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "durationInFrames" && ts.isNumericLiteral(p.initializer)) return Number(p.initializer.text);
        }
      }
    }
  } catch {
    /* fall through */
  }
  return undefined;
}

function fail(problems: string[]): TsxCheckResult {
  return { ok: false, problems: [...new Set(problems)].slice(0, MAX_PROBLEMS) };
}

/** Text echoed back in a problem: printable ASCII only (others become '?'), at most 30 characters. */
export function echo(text: string): string {
  let out = "";
  for (let i = 0; i < text.length && out.length < MAX_ECHO; i++) {
    const c = text.charCodeAt(i);
    out += c >= 0x20 && c < 0x7f ? text[i] : "?";
  }
  return text.length > MAX_ECHO ? `${out.slice(0, MAX_ECHO - 3)}...` : out;
}

// Invisible and direction-changing characters (Trojan Source, zero-width, Unicode tag smuggling), NUL and other controls.
function checkChars(source: string, problems: string[]): void {
  let line = 1;
  for (let i = 0; i < source.length; i++) {
    let c = source.charCodeAt(i);
    if (c === 10) { line++; continue; }
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < source.length) {
      const lo = source.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00); i++; }
    }
    const bad = (c < 0x20 && c !== 9 && c !== 13) || (c >= 0x7f && c <= 0x9f) || c === 0xad || c === 0x61c || c === 0x180e ||
      (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2060 && c <= 0x206f) || c === 0xfeff ||
      (c >= 0xfff0 && c <= 0xfffb) || (c >= 0xd800 && c <= 0xdfff) || (c >= 0xe0000 && c <= 0xe007f);
    if (bad) {
      problems.push(`line ${line}: invisible or control character U+${c.toString(16).toUpperCase().padStart(4, "0")} is not allowed.`);
      if (problems.length >= MAX_PROBLEMS) return;
    }
  }
}

function walk(source: string, problems: string[]): void {
  const sf = ts.createSourceFile("scene.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const add = (n: ts.Node, msg: string) => { if (problems.length < MAX_PROBLEMS * 2) problems.push(`line ${lineOf(n.getStart(sf))}: ${msg}`); };
  const snip = (n: ts.Node) => echo(n.getText(sf));

  const syntax = (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  for (const d of syntax.slice(0, 5)) {
    problems.push(`line ${d.start === undefined ? "?" : lineOf(d.start)}: syntax error: ${echo(ts.flattenDiagnosticMessageText(d.messageText, " "))}`);
  }
  if (syntax.length > 0) return;

  let reactDefault = false;
  const imported = new Set<string>();
  const components = new Set<string>();
  let hasDefault = false;
  let hasMeta = false;
  const seenComments = new Set<number>();

  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) checkImport(st);
    else if (ts.isImportEqualsDeclaration(st)) add(st, "'import x = require()' is not allowed.");
  }
  // Pre-pass. Names a JSX tag may use (functions and const arrow/function components declared in this file); every local
  // binding by the scope that holds it (so `top` can be a local while the global `top` stays refused); numeric for-loop
  // counters; function names (for the recursion check).
  const scopes = new Map<ts.Node, Set<string>>();
  const counterScopes = new Set<ts.Node>(); // for statements whose only binding is a numeric counter
  const fnNames = new Set<string>();
  const calls = new Map<string, Set<string>>();
  const declare = (scope: ts.Node, name: ts.BindingName) => {
    for (const id of bindingIds(name)) {
      let set = scopes.get(scope);
      if (!set) scopes.set(scope, (set = new Set()));
      set.add(id.text);
    }
  };
  forEachNode(sf, (n) => {
    if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name) { components.add(n.name.text); declare(n.parent, n.name); }
    if (ts.isFunctionExpression(n) && n.name) declare(n, n.name);
    if (ts.isParameter(n)) declare(n.parent, n.name);
    const name = fnNameOf(n);
    if (name) fnNames.add(name);
    if (!ts.isVariableDeclaration(n)) return;
    declare(varScope(n), n.name);
    if (isCounterDecl(n)) counterScopes.add(n.parent.parent);
    if (ts.isIdentifier(n.name) && n.initializer && ts.isVariableDeclarationList(n.parent) && n.parent.flags & ts.NodeFlags.Const) {
      let init: ts.Expression = n.initializer;
      while (ts.isParenthesizedExpression(init)) init = init.expression;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) components.add(n.name.text);
    }
  });
  /** The scope node of the nearest local binding of this name, or undefined when it names a global. */
  const scopeOf = (id: ts.Identifier): ts.Node | undefined => {
    for (let a: ts.Node | undefined = id.parent; a; a = a.parent) if (scopes.get(a)?.has(id.text)) return a;
    return undefined;
  };
  const resolvesLocally = (id: ts.Identifier) => scopeOf(id) !== undefined;
  let fn: string | undefined; // the named function the walk is in
  const edge = (to: string) => {
    if (!fn || !fnNames.has(to)) return;
    let set = calls.get(fn);
    if (!set) calls.set(fn, (set = new Set()));
    set.add(to);
  };

  // Iterative walk: deep nesting cannot overflow the stack. Type-only parts are skipped (erased at compile time). The
  // left spine of an `a + b + c ...` chain does not count as nesting (the parser reads it in a loop, not recursively).
  const stack: { n: ts.Node; d: number; fn?: string }[] = [{ n: sf, d: 0 }];
  while (stack.length > 0 && problems.length < MAX_PROBLEMS * 2) {
    const top = stack.pop()!;
    const { n, d } = top;
    fn = top.fn;
    if (d > MAX_DEPTH) { add(n, "the code is nested too deeply."); return; }
    comments(n);
    if (isTypeOnlyNode(n)) continue;
    visit(n);
    const inner = fnNameOf(n) ?? fn;
    const kids: ts.Node[] = [];
    ts.forEachChild(n, (k) => { kids.push(k); });
    for (let i = kids.length - 1; i >= 0; i--) {
      const k = kids[i]!;
      stack.push({ n: k, d: isPlus(n) && isPlus(k) && (n as ts.BinaryExpression).left === k ? d : d + 1, fn: inner });
    }
  }
  checkRecursion();
  if (!hasDefault) problems.push("The file must 'export default' the scene component.");
  if (!hasMeta) problems.push(`The file must 'export const meta = { durationInFrames, fps: ${TSX_META.fps}, width: ${TSX_META.width}, height: ${TSX_META.height} }'.`);

  function comments(n: ts.Node): void {
    if (n.kind === ts.SyntaxKind.JsxText) return;
    for (const r of [...(ts.getLeadingCommentRanges(source, n.pos) ?? []), ...(ts.getTrailingCommentRanges(source, n.end) ?? [])]) {
      if (seenComments.has(r.pos)) continue;
      seenComments.add(r.pos);
      const text = source.slice(r.pos, r.end).toLowerCase();
      const hit = COMMENT_DIRECTIVES.find((d) => text.includes(d));
      if (hit && problems.length < MAX_PROBLEMS * 2) problems.push(`line ${lineOf(r.pos)}: comment directive '${hit}' is not allowed.`);
    }
  }

  function checkImport(st: ts.ImportDeclaration): void {
    const spec = ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : "";
    const allowed = Object.prototype.hasOwnProperty.call(TSX_IMPORTS, spec) ? TSX_IMPORTS[spec] : undefined;
    if (!allowed) return add(st, `import from '${echo(spec)}' is not allowed (only ${Object.keys(TSX_IMPORTS).join(", ")}).`);
    if (st.attributes) return add(st, "import attributes are not allowed.");
    const clause = st.importClause;
    if (!clause) return add(st, `side-effect import of '${echo(spec)}' is not allowed.`);
    if (clause.isTypeOnly) return;
    if (clause.name) {
      if (spec === "react" && clause.name.text === REACT_DEFAULT) reactDefault = true;
      else add(clause, `default import '${echo(clause.name.text)}' from '${echo(spec)}' is not allowed.`);
    }
    const nb = clause.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) add(nb, `'import * as' from '${echo(spec)}' is not allowed; import names one by one.`);
    if (nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements) {
        if (el.isTypeOnly) continue;
        const name = (el.propertyName ?? el.name).text;
        if (el.propertyName && name !== el.name.text) add(el, `renaming imports ('${snip(el)}') is not allowed.`);
        else if (!allowed.includes(name)) add(el, `'${echo(name)}' from '${echo(spec)}' is not allowed.`);
        else imported.add(name);
      }
    }
  }

  function visit(n: ts.Node): void {
    switch (n.kind) {
      case ts.SyntaxKind.Identifier: return checkIdentifier(n as ts.Identifier);
      case ts.SyntaxKind.PrivateIdentifier: {
        const p = n as ts.PrivateIdentifier;
        if (!IDENT.test(p.text.slice(1)) || p.getText(sf) !== p.text) add(n, "identifiers must be plain ASCII.");
        return;
      }
      case ts.SyntaxKind.MetaProperty: return add(n, `'${snip(n)}' is not allowed.`);
      case ts.SyntaxKind.WithStatement: return add(n, "'with' is not allowed.");
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement: return add(n, "while/do loops are not allowed; use a for loop with a number bound, or .map().");
      case ts.SyntaxKind.ForInStatement: return add(n, "for...in is not allowed; use Object.keys().");
      case ts.SyntaxKind.ForStatement: return checkFor(n as ts.ForStatement);
      case ts.SyntaxKind.ForOfStatement: return checkForOf(n as ts.ForOfStatement);
      case ts.SyntaxKind.AwaitExpression: return add(n, "await is not allowed: a frame must render synchronously.");
      case ts.SyntaxKind.AsyncKeyword: return add(n, "async functions are not allowed: a frame must render synchronously.");
      case ts.SyntaxKind.YieldExpression: return add(n, "generators are not allowed.");
      case ts.SyntaxKind.FunctionExpression:
      case ts.SyntaxKind.MethodDeclaration: {
        if ((n as ts.FunctionExpression).asteriskToken) add(n, "generators are not allowed.");
        return;
      }
      case ts.SyntaxKind.ThisKeyword:
      case ts.SyntaxKind.SuperKeyword: return add(n, `'${snip(n)}' is not allowed; pass values as props or arguments.`);
      case ts.SyntaxKind.ClassDeclaration:
      case ts.SyntaxKind.ClassExpression: return add(n, "classes are not allowed; write function components.");
      case ts.SyntaxKind.GetAccessor:
      case ts.SyntaxKind.SetAccessor: return add(n, "getters and setters are not allowed.");
      case ts.SyntaxKind.RegularExpressionLiteral: return add(n, "regular expressions are not allowed.");
      case ts.SyntaxKind.TaggedTemplateExpression: return add(n, "tagged templates are not allowed.");
      case ts.SyntaxKind.ElementAccessExpression: {
        const ea = n as ts.ElementAccessExpression;
        return checkKey(ea, ea.argumentExpression, ea.expression);
      }
      case ts.SyntaxKind.ComputedPropertyName: return checkKey(n, (n as ts.ComputedPropertyName).expression);
      case ts.SyntaxKind.ShorthandPropertyAssignment: {
        // ({ constructor } = fn) reads fn.constructor
        const s = n as ts.ShorthandPropertyAssignment;
        if (isWriteTarget(s.parent)) memberName(s.name);
        return;
      }
      case ts.SyntaxKind.PropertyAccessExpression: return checkPropertyAccess(n as ts.PropertyAccessExpression);
      case ts.SyntaxKind.PropertyAssignment: return checkStyleKey(n as ts.PropertyAssignment);
      case ts.SyntaxKind.VariableDeclaration: {
        const v = n as ts.VariableDeclaration;
        const init = v.initializer && unwrap(v.initializer);
        if (!ts.isIdentifier(v.name) && init && ts.isIdentifier(init) && (GLOBAL_OBJECTS.has(init.text) || init.text === REACT_DEFAULT)) add(n, `destructuring from '${echo(init.text)}' is not allowed.`);
        return;
      }
      case ts.SyntaxKind.CallExpression: return checkCall(n as ts.CallExpression);
      case ts.SyntaxKind.NewExpression: {
        const ne = n as ts.NewExpression;
        if (!ts.isIdentifier(ne.expression) || !NEW_OK.has(ne.expression.text)) return add(n, `'new ${snip(ne.expression)}' is not allowed (only new Map, new Set, new Array).`);
        if (ne.expression.text === "Array" && !arrayArgsOk(ne.arguments)) add(n, `new Array(n) needs a number n up to ${MAX_LOOP_BOUND}.`);
        return;
      }
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral: return checkString(n, (n as ts.StringLiteral).text);
      case ts.SyntaxKind.TemplateExpression: return checkTemplate(n as ts.TemplateExpression);
      case ts.SyntaxKind.BinaryExpression: return checkConcat(n as ts.BinaryExpression);
      case ts.SyntaxKind.JsxOpeningElement:
      case ts.SyntaxKind.JsxSelfClosingElement: return checkJsxTag(n as ts.JsxOpeningElement | ts.JsxSelfClosingElement);
      case ts.SyntaxKind.JsxSpreadAttribute: return add(n, "spreading props into JSX ({...x}) is not allowed; pass each prop by name.");
      case ts.SyntaxKind.JsxAttribute: return checkJsxAttr(n as ts.JsxAttribute);
      case ts.SyntaxKind.ExportDeclaration: {
        const e = n as ts.ExportDeclaration;
        if (!e.isTypeOnly) add(n, e.moduleSpecifier ? "re-exporting from another module is not allowed." : "'export { ... }' is not allowed; use 'export default' and 'export const meta'.");
        return;
      }
      case ts.SyntaxKind.ExportAssignment: {
        if ((n as ts.ExportAssignment).isExportEquals) return add(n, "'export =' is not allowed.");
        if (hasDefault) add(n, "only one default export is allowed.");
        hasDefault = true;
        return;
      }
      case ts.SyntaxKind.FunctionDeclaration:
        if ((n as ts.FunctionDeclaration).asteriskToken) add(n, "generators are not allowed.");
        return checkExported(n as ts.FunctionDeclaration);
      case ts.SyntaxKind.VariableStatement: return checkExported(n as ts.VariableStatement);
      case ts.SyntaxKind.ModuleDeclaration: return add(n, "namespaces/modules are not allowed.");
    }
  }

  function checkExported(n: ts.FunctionDeclaration | ts.ClassDeclaration | ts.VariableStatement): void {
    const mods = ts.canHaveModifiers(n) ? ts.getModifiers(n) ?? [] : [];
    if (!mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return;
    if (!ts.isVariableStatement(n)) {
      if (!mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) return add(n, "only 'export default' and 'export const meta' are allowed.");
      if (hasDefault) add(n, "only one default export is allowed.");
      hasDefault = true;
      return;
    }
    for (const decl of n.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== "meta") { add(decl, "only 'export default' and 'export const meta' are allowed."); continue; }
      if (!(n.declarationList.flags & ts.NodeFlags.Const)) add(decl, "meta must be 'export const meta'.");
      checkMeta(decl);
    }
  }

  function checkMeta(decl: ts.VariableDeclaration): void {
    hasMeta = true;
    let init = decl.initializer;
    while (init && (ts.isAsExpression(init) || ts.isSatisfiesExpression(init) || ts.isParenthesizedExpression(init))) init = init.expression;
    if (!init || !ts.isObjectLiteralExpression(init)) return add(decl, "meta must be a plain object of numbers.");
    const got: Record<string, number> = {};
    for (const p of init.properties) {
      if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name) || !ts.isNumericLiteral(p.initializer)) { add(p, "meta may only hold plain number values."); continue; }
      got[p.name.text] = Number(p.initializer.text);
    }
    if (Object.keys(got).sort().join(",") !== "durationInFrames,fps,height,width") add(init, "meta must have exactly durationInFrames, fps, width, height.");
    const dur = got.durationInFrames;
    if (dur !== undefined && !(Number.isInteger(dur) && dur >= 1 && dur <= TSX_MAX_FRAMES)) add(init, `meta.durationInFrames must be a whole number from 1 to ${TSX_MAX_FRAMES}.`);
    for (const k of ["fps", "width", "height"] as const) {
      if (got[k] !== undefined && got[k] !== TSX_META[k]) add(init, `meta.${k} must be ${TSX_META[k]}.`);
    }
  }

  function isProtected(name: string): boolean {
    return GLOBAL_OBJECTS.has(name) || imported.has(name) || (reactDefault && name === REACT_DEFAULT);
  }

  function memberName(id: ts.Identifier): void {
    if (FORBIDDEN_MEMBERS.has(id.text.toLowerCase())) add(id, `'${echo(id.text)}' is not allowed.`);
  }

  // Forbidden names are judged by position: a member name (x.now) against FORBIDDEN_MEMBERS, a reference to a global
  // against FORBIDDEN_GLOBALS (unless a local of that name is in scope), and HARD_GLOBALS everywhere.
  function checkIdentifier(id: ts.Identifier): void {
    const p = id.parent;
    const jsxAttr = ts.isJsxAttribute(p) || ts.isJsxNamespacedName(p);
    const jsxTag = (ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxClosingElement(p)) && p.tagName === id;
    if (!(jsxAttr || jsxTag ? JSX_IDENT : IDENT).test(id.text) || id.getText(sf) !== id.text) return add(id, "identifiers must be plain ASCII letters, digits, _ or $ (no escapes).");
    if (HARD_GLOBALS.has(id.text) && !jsxAttr) return add(id, `'${echo(id.text)}' is not allowed${hint(id.text)}.`);
    if (jsxTag) { if (!ts.isJsxClosingElement(p)) edge(id.text); return; }
    const isMember = (ts.isPropertyAccessExpression(p) && p.name === id) || (ts.isQualifiedName(p) && p.right === id) ||
      ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) && p.name === id) ||
      (ts.isBindingElement(p) && p.propertyName === id) || jsxAttr || ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p);
    if (isMember) return memberName(id);
    if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return;
    const isDecl = (ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) ||
      ts.isClassDeclaration(p) || ts.isClassExpression(p) || ts.isBindingElement(p) || ts.isEnumDeclaration(p)) && p.name === id;
    if (isDecl) {
      if (ts.isBindingElement(p) && !p.propertyName && ts.isObjectBindingPattern(p.parent)) memberName(id); // const { constructor } = f
      if (NO_SHADOW.has(id.text) || isProtected(id.text)) add(id, `'${echo(id.text)}' may not be declared again (it would hide the real one).`);
      return;
    }
    edge(id.text);
    if (FORBIDDEN_GLOBALS.has(id.text) && !resolvesLocally(id)) return add(id, `'${echo(id.text)}' is not allowed${hint(id.text)}.`);
    if (isProtected(id.text) && !directUse(id)) add(id, `'${echo(id.text)}' may only be used as ${echo(id.text)}.name or ${echo(id.text)}(...): not stored, passed, destructured or changed.`);
  }

  /** X.name, X[...], X(...), new X(...), `instanceof X`, and Boolean/Number/String as a call argument. */
  function directUse(id: ts.Identifier): boolean {
    const p = id.parent;
    if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p) || ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === id) return true;
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && p.right === id) return true;
    return ts.isCallExpression(p) && p.arguments.includes(id) && AS_ARGUMENT_OK.has(id.text);
  }

  function checkPropertyAccess(pa: ts.PropertyAccessExpression): void {
    const obj = pa.expression;
    const name = pa.name.text;
    const root = ts.isIdentifier(obj) ? obj.text : undefined;
    if (root === "Math" && name === "random") add(pa, "Math.random is not allowed; use random('seed') from remotion.");
    if (root === REACT_DEFAULT && reactDefault && !TSX_IMPORTS.react!.includes(name)) add(pa, `'React.${echo(name)}' is not allowed (only ${TSX_IMPORTS.react!.join(", ")}).`);
    if (root === "Array" && name === "from") add(pa, "Array.from is not allowed; use an array literal, Array(n) or a bounded for loop.");
    if (root && isProtected(root) && isWriteTarget(pa)) add(pa, `changing '${echo(root)}.${echo(name)}' is not allowed.`);
    if (name === "length" && isWriteTarget(pa)) add(pa, "changing .length is not allowed.");
    if (name === "fill" && !boundedArray(obj)) add(pa, `.fill() is only allowed on an array literal or Array(n) with a number n up to ${MAX_LOOP_BOUND}.`);
  }

  // Computed keys (x[k], { [k]: v }, const { [k]: v } = x) must be numbers: no text key can then spell a forbidden name.
  function checkKey(n: ts.Node, key: ts.Expression, obj?: ts.Expression): void {
    const lit = literalString(key);
    const root = obj && ts.isIdentifier(obj) ? obj.text : undefined;
    if (lit !== undefined) {
      if (root === REACT_DEFAULT && reactDefault && !TSX_IMPORTS.react!.includes(lit)) add(n, `'React.${echo(lit)}' is not allowed (only ${TSX_IMPORTS.react!.join(", ")}).`);
      const low = lit.toLowerCase();
      if (FORBIDDEN_MEMBERS.has(low) || FORBIDDEN_GLOBALS.has(lit) || STRING_BANNED.has(low) || lit === "random") return add(n, `the key '${echo(lit)}' is not allowed.`);
      return add(n, "text keys in [...] are not allowed; write x.name, or use a number key.");
    }
    if (isNumericKey(key, 0)) return;
    if (root && isProtected(root)) return add(n, `computed lookup on '${echo(root)}' is not allowed.`);
    add(n, "computed keys must be numbers (a number, arithmetic like i % 3, Math.floor(x) or a for-loop counter); keys built from text are not allowed.");
  }

  /** True when the expression can only produce a number. Unknown shapes are false (refused). */
  function isNumericKey(e: ts.Expression, depth: number): boolean {
    if (depth > 50) return false;
    const u = unwrap(e) as ts.Expression;
    if (ts.isNumericLiteral(u) || ts.isBigIntLiteral(u)) return true;
    if (ts.isIdentifier(u)) { const s = scopeOf(u); return !!s && counterScopes.has(s); }
    if (ts.isPrefixUnaryExpression(u)) return u.operator === ts.SyntaxKind.MinusToken || u.operator === ts.SyntaxKind.PlusToken || u.operator === ts.SyntaxKind.TildeToken;
    if (ts.isBinaryExpression(u)) {
      if (ARITH.has(u.operatorToken.kind)) return true;
      return u.operatorToken.kind === ts.SyntaxKind.PlusToken && isNumericKey(u.left, depth + 1) && isNumericKey(u.right, depth + 1);
    }
    if (ts.isConditionalExpression(u)) return isNumericKey(u.whenTrue, depth + 1) && isNumericKey(u.whenFalse, depth + 1);
    const c = ts.isCallExpression(u) ? u.expression : undefined;
    return !!c && ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && c.expression.text === "Math" && MATH_NUMERIC.has(c.name.text);
  }

  function checkRecursion(): void {
    const state = new Map<string, 1 | 2>(); // 1: on the current path, 2: done
    for (const start of calls.keys()) {
      if (state.has(start)) continue;
      state.set(start, 1);
      const path: [string, Iterator<string>][] = [[start, (calls.get(start) ?? new Set<string>()).values()]];
      while (path.length > 0) {
        const [name, it] = path[path.length - 1]!;
        const next = it.next();
        if (next.done) { state.set(name, 2); path.pop(); continue; }
        const s = state.get(next.value);
        if (s === 1) { problems.push(`'${echo(next.value)}' calls itself (directly or through another function): recursion is not allowed.`); return; }
        if (s === undefined) { state.set(next.value, 1); path.push([next.value, (calls.get(next.value) ?? new Set<string>()).values()]); }
      }
    }
  }

  function checkStyleKey(p: ts.PropertyAssignment): void {
    const name = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text.toLowerCase() : "";
    if (name.includes("animation") || name.includes("transition")) add(p, "CSS animations/transitions are not allowed; animate from useCurrentFrame().");
  }

  function checkCall(c: ts.CallExpression): void {
    if (c.expression.kind === ts.SyntaxKind.ImportKeyword) return add(c, "dynamic import() is not allowed.");
    if (!ts.isIdentifier(c.expression)) return;
    if (c.expression.text === "random" && imported.has("random")) {
      const a = c.arguments[0];
      const u = a && unwrap(a);
      const fixed = !!u && u.kind !== ts.SyntaxKind.NullKeyword && !ts.isVoidExpression(u) && !(ts.isIdentifier(u) && u.text === "undefined");
      if (!fixed) add(c, "random() needs a fixed seed, e.g. random('dot-1').");
    }
    if (c.expression.text === "staticFile") checkStaticFile(c);
    if (c.expression.text === "Array" && !arrayArgsOk(c.arguments)) add(c, `Array(n) needs a number n up to ${MAX_LOOP_BOUND}.`);
  }

  // Only a plain literal name: no template, no variable, so the files a scene can reach are known before it runs.
  function checkStaticFile(c: ts.CallExpression): void {
    const a = c.arguments.length === 1 ? c.arguments[0]! : undefined;
    const ok = !!a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) && isStaticName(a.text);
    if (!ok) add(c, "staticFile() needs one plain relative file name as a literal, e.g. staticFile('assets/a.png').");
  }

  function checkString(n: ts.Node, text: string): void {
    if (STRING_BANNED.has(text.toLowerCase())) add(n, `the text '${echo(text)}' is not allowed as a value.`);
    if (text.includes("\\")) add(n, "backslashes in text are not allowed.");
    const low = text.toLowerCase();
    if (low.includes("image-set(") || low.includes("src(")) add(n, "CSS image-set()/src() are not allowed.");
    // CSS url(...) only as url(#id) (an SVG reference in this document); pictures use <Img src={staticFile(...)} />.
    for (let i = low.indexOf("url("); i >= 0; i = low.indexOf("url(", i + 4)) {
      let j = i + 4;
      while (low[j] === " " || low[j] === "'" || low[j] === '"') j++;
      if (low[j] !== "#") { add(n, "CSS url(...) is not allowed except url(#id) or url(${staticFile('...')})."); break; }
    }
  }

  function checkTemplate(t: ts.TemplateExpression): void {
    const folded = foldTemplate(t);
    if (folded !== undefined) return checkString(t, folded);
    // url(${staticFile('x')}) is the one allowed shape of a url( right before a substitution.
    const parts = [t.head.text, ...t.templateSpans.map((s) => s.literal.text)];
    for (let i = 0; i < parts.length; i++) {
      let part = parts[i]!;
      const span = t.templateSpans[i];
      const m = /url\(\s*["']?$/i.exec(part);
      if (m && span && ts.isCallExpression(span.expression) && ts.isIdentifier(span.expression.expression) && span.expression.expression.text === "staticFile") part = part.slice(0, m.index);
      checkString(t, part);
    }
  }

  function checkConcat(b: ts.BinaryExpression): void {
    if (b.operatorToken.kind !== ts.SyntaxKind.PlusToken) return;
    if (ts.isBinaryExpression(b.parent) && b.parent.operatorToken.kind === ts.SyntaxKind.PlusToken) return; // the whole chain once
    const runs = literalRuns(b);
    if ((runs.terms ?? 0) > MAX_PLUS_TERMS) add(b, `a '+' chain may have at most ${MAX_PLUS_TERMS} parts.`);
    for (const run of runs) checkString(b, run);
  }

  function checkJsxTag(el: ts.JsxOpeningElement | ts.JsxSelfClosingElement): void {
    const tag = el.tagName;
    if (ts.isIdentifier(tag)) {
      const name = tag.text;
      if (/^[a-z]/.test(name) || name.includes("-")) {
        if (name.includes("-")) return add(el, `custom element <${echo(name)}> is not allowed.`);
        if (FORBIDDEN_TAGS.has(name.toLowerCase())) add(el, name === "img" ? "<img> is not allowed; use <Img src={staticFile('...')} /> from remotion." : `<${echo(name)}> is not allowed.`);
        return;
      }
      if (!imported.has(name) && !components.has(name)) add(el, `<${echo(name)}> must be a component declared in this file or imported from the allowed list.`);
      return;
    }
    let root: ts.Node = tag;
    while (ts.isPropertyAccessExpression(root)) root = root.expression;
    const ok = ts.isIdentifier(root) && (imported.has(root.text) || components.has(root.text) || (root.text === REACT_DEFAULT && reactDefault));
    if (!ok) add(el, `the tag <${snip(tag)}> is not allowed.`);
  }

  function checkJsxAttr(a: ts.JsxAttribute): void {
    const raw = ts.isJsxNamespacedName(a.name) ? `${a.name.namespace.text}:${a.name.name.text}` : a.name.text;
    const key = raw.toLowerCase().replace(/[:-]/g, "");
    if (key === "dangerouslysetinnerhtml") return add(a, "dangerouslySetInnerHTML is not allowed.");
    if (key === "ref") return add(a, "ref is not allowed.");
    if (key.startsWith("on")) return add(a, `event handler '${echo(raw)}' is not allowed.`);
    if (key === "is" || key === "srcdoc") return add(a, `'${echo(raw)}' is not allowed.`);
    const urlish = URL_ATTRS.has(key) || key.endsWith("href");
    if (!urlish) return;
    const v = a.initializer;
    if (v && ts.isStringLiteral(v) && key.endsWith("href") && /^#[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v.text)) return; // <use href="#id">
    const e = v && ts.isJsxExpression(v) ? v.expression : undefined;
    if (e && ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "staticFile") return;
    add(a, `'${echo(raw)}' must be staticFile('...')${key.endsWith("href") ? " or '#id'" : ""}.`);
  }

  function checkFor(f: ts.ForStatement): void {
    const init = f.initializer;
    const decl = init && ts.isVariableDeclarationList(init) && init.declarations.length === 1 ? init.declarations[0] : undefined;
    const v = decl && ts.isIdentifier(decl.name) && decl.initializer && ts.isNumericLiteral(decl.initializer) ? decl.name.text : undefined;
    const cond = f.condition;
    const inc = f.incrementor;
    const boundOk = !!v && !!cond && ts.isBinaryExpression(cond) && ts.isIdentifier(cond.left) && cond.left.text === v &&
      (cond.operatorToken.kind === ts.SyntaxKind.LessThanToken || cond.operatorToken.kind === ts.SyntaxKind.LessThanEqualsToken) &&
      ts.isNumericLiteral(cond.right) && Number(cond.right.text) <= MAX_LOOP_BOUND;
    const stepOk = !!v && !!inc && (
      ((ts.isPostfixUnaryExpression(inc) || ts.isPrefixUnaryExpression(inc)) && inc.operator === ts.SyntaxKind.PlusPlusToken && ts.isIdentifier(inc.operand) && inc.operand.text === v) ||
      (ts.isBinaryExpression(inc) && inc.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken && ts.isIdentifier(inc.left) && inc.left.text === v && ts.isNumericLiteral(inc.right) && Number(inc.right.text) >= 1));
    if (!boundOk || !stepOk) return add(f, `for loops need the shape 'for (let i = 0; i < 100; i++)' with a number bound up to ${MAX_LOOP_BOUND}.`);
    if (assigns(f.statement, v!)) add(f, `the loop variable '${echo(v!)}' may not be changed inside the loop.`);
    checkNesting(f);
  }

  function checkForOf(f: ts.ForOfStatement): void {
    if (f.awaitModifier) return add(f, "for await is not allowed.");
    const e = unwrap(f.expression);
    if (!ts.isArrayLiteralExpression(e) || e.elements.some(ts.isSpreadElement)) return add(f, "for...of only over an array literal, e.g. for (const c of ['a', 'b']); use .map() on other arrays.");
    checkNesting(f);
  }

  /** At most MAX_LOOP_NEST loops inside each other (functions do not reset the count), and a bounded total run count. */
  function checkNesting(loop: ts.Node): void {
    let depth = 0;
    let product = 1;
    for (let a: ts.Node | undefined = loop; a; a = a.parent) {
      if (ts.isForStatement(a) || ts.isForOfStatement(a)) { depth++; product *= loopCount(a); }
    }
    if (depth > MAX_LOOP_NEST) add(loop, `loops may be nested at most ${MAX_LOOP_NEST} deep.`);
    else if (product > MAX_LOOP_PRODUCT) add(loop, `nested loops may run at most ${MAX_LOOP_PRODUCT} times in total.`);
  }
}

/** Upper bound on a checked loop's runs (shapes that fail their own check count as 1; they are refused anyway). */
function loopCount(n: ts.ForStatement | ts.ForOfStatement): number {
  if (ts.isForOfStatement(n)) {
    const e = unwrap(n.expression);
    return ts.isArrayLiteralExpression(e) ? Math.max(1, e.elements.length) : 1;
  }
  const c = n.condition;
  return c && ts.isBinaryExpression(c) && ts.isNumericLiteral(c.right) ? Math.max(1, Number(c.right.text)) : 1;
}

/** `for (let i = <number>; ...)`: a numeric loop counter (the loop's own check enforces the rest of the shape). */
function isCounterDecl(d: ts.VariableDeclaration): boolean {
  const list = d.parent;
  return ts.isIdentifier(d.name) && !!d.initializer && ts.isNumericLiteral(d.initializer) && ts.isVariableDeclarationList(list) &&
    !!(list.flags & ts.NodeFlags.Let) && list.declarations.length === 1 && ts.isForStatement(list.parent) && list.parent.initializer === list;
}

/** The node whose subtree a variable declaration is visible in (block for let/const, function for var). */
function varScope(d: ts.VariableDeclaration): ts.Node {
  const list = d.parent;
  if (!ts.isVariableDeclarationList(list)) return list; // catch (e)
  if (list.flags & ts.NodeFlags.BlockScoped) return ts.isVariableStatement(list.parent) ? list.parent.parent : list.parent;
  let a: ts.Node = list;
  while (a.parent && !ts.isFunctionLike(a) && !ts.isSourceFile(a)) a = a.parent;
  return a;
}

function bindingIds(name: ts.BindingName): ts.Identifier[] {
  const out: ts.Identifier[] = [];
  const todo: ts.BindingName[] = [name];
  while (todo.length > 0) {
    const n = todo.pop()!;
    if (ts.isIdentifier(n)) out.push(n);
    else for (const el of n.elements) if (ts.isBindingElement(el)) todo.push(el.name);
  }
  return out;
}

/** The name a function node is known by: its own name, or the variable it initialises. */
function fnNameOf(n: ts.Node): string | undefined {
  if ((ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)) && n.name) return n.name.text;
  if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)) return n.parent.name.text;
  return undefined;
}

function isPlus(n: ts.Node): boolean {
  return ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken;
}

/** Array(n)/new Array(n): no argument, two or more elements, or one number literal up to MAX_LOOP_BOUND. */
function arrayArgsOk(args: ts.NodeArray<ts.Expression> | undefined): boolean {
  if (!args || args.length === 0) return true;
  if (args.some(ts.isSpreadElement)) return false;
  if (args.length > 1) return true;
  const a = unwrap(args[0]!);
  return ts.isNumericLiteral(a) && Number(a.text) <= MAX_LOOP_BOUND;
}

function boundedArray(e: ts.Expression): boolean {
  const u = unwrap(e);
  if (ts.isArrayLiteralExpression(u)) return true;
  return (ts.isCallExpression(u) || ts.isNewExpression(u)) && ts.isIdentifier(u.expression) && u.expression.text === "Array" && arrayArgsOk(u.arguments);
}

/** True when the node is (part of) the left side of an assignment, ++/--, or a for...of/in target. */
function isWriteTarget(n: ts.Node): boolean {
  let c = n;
  for (let p = n.parent; p; c = p, p = p.parent) {
    if (ts.isParenthesizedExpression(p) || ts.isArrayLiteralExpression(p) || ts.isSpreadElement(p) || ts.isObjectLiteralExpression(p) ||
      ts.isShorthandPropertyAssignment(p) || ts.isSpreadAssignment(p) || ts.isNonNullExpression(p) || ts.isAsExpression(p) ||
      ts.isSatisfiesExpression(p) || (ts.isPropertyAssignment(p) && p.initializer === c)) continue;
    if (ts.isBinaryExpression(p)) return p.left === c && p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
    if (ts.isForOfStatement(p) || ts.isForInStatement(p)) return p.initializer === c;
    if (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) return p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken;
    return false;
  }
  return false;
}

const hint = (name: string): string =>
  TIMERS.has(name) ? " (animate from useCurrentFrame())"
    : name === "Date" || name === "performance" ? " (time comes from useCurrentFrame())"
      : NETWORK.has(name) ? " (there is no network)" : "";

// Type positions are erased by the compiler. ExpressionWithTypeArguments is NOT skipped: it also holds runtime
// expressions (`class A extends B`, `fn<T>` instantiation).
function isTypeOnlyNode(n: ts.Node): boolean {
  if (n.kind === ts.SyntaxKind.ExpressionWithTypeArguments) return false;
  return ts.isTypeNode(n) || ts.isTypeAliasDeclaration(n) || ts.isInterfaceDeclaration(n) || ts.isTypeParameterDeclaration(n) ||
    (ts.isHeritageClause(n) && n.token === ts.SyntaxKind.ImplementsKeyword);
}

function forEachNode(root: ts.Node, fn: (n: ts.Node) => void): void {
  const todo: ts.Node[] = [root];
  while (todo.length > 0) {
    const n = todo.pop()!;
    fn(n);
    ts.forEachChild(n, (k) => { todo.push(k); });
  }
}

function unwrap(e: ts.Node): ts.Node {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  return e;
}

/** The constant string value of a literal, template or `+` chain of literals; undefined when any part is not constant. */
function literalString(e: ts.Node): string | undefined {
  e = unwrap(e);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isTemplateExpression(e)) return foldTemplate(e);
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const runs = literalRuns(e);
    return runs.length === 1 && runs.complete ? runs[0] : undefined;
  }
  return undefined;
}

/** The literal runs of a `+` chain: "a" + "b" + x + "c" gives ["ab", "c"]; complete when every operand was constant. */
function literalRuns(b: ts.BinaryExpression): string[] & { complete?: boolean; terms?: number } {
  const operands: ts.Node[] = [];
  const todo: ts.Node[] = [b];
  while (todo.length > 0) {
    const n = unwrap(todo.pop()!);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) { todo.push(n.right, n.left); continue; }
    operands.push(n);
  }
  const runs: string[] & { complete?: boolean; terms?: number } = [];
  runs.terms = operands.length;
  let cur: string | undefined;
  let complete = true;
  for (const o of operands) {
    const v = ts.isNumericLiteral(o) ? String(Number(o.text)) : literalString(o);
    if (v === undefined) { complete = false; if (cur !== undefined) runs.push(cur); cur = undefined; continue; }
    cur = (cur ?? "") + v;
  }
  if (cur !== undefined) runs.push(cur);
  runs.complete = complete;
  return runs;
}

function foldTemplate(t: ts.TemplateExpression): string | undefined {
  let out = t.head.text;
  for (const s of t.templateSpans) {
    const v = literalString(s.expression);
    if (v === undefined) return undefined;
    out += v + s.literal.text;
  }
  return out;
}

function assigns(body: ts.Node, v: string): boolean {
  let hit = false;
  forEachNode(body, (n) => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment && refersTo(n.left, v)) hit = true;
    if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken) && refersTo(n.operand, v)) hit = true;
  });
  return hit;
}

function refersTo(e: ts.Node, v: string): boolean {
  let hit = false;
  forEachNode(e, (n) => { if (ts.isIdentifier(n) && n.text === v) hit = true; });
  return hit;
}
