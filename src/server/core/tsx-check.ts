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
  "fetchLater", "Notification",
]);
// Member names that may not be read or written on anything (prototype walking, DOM escape hatches, the clock).
const FORBIDDEN_MEMBERS = new Set([
  "constructor", "prototype", "__proto__", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__",
  "getPrototypeOf", "setPrototypeOf", "defineProperty", "defineProperties", "getOwnPropertyDescriptor",
  "getOwnPropertyDescriptors", "fromCharCode", "fromCodePoint", "raw", "innerHTML", "outerHTML", "insertAdjacentHTML",
  "srcdoc", "contentWindow", "contentDocument", "ownerDocument", "defaultView", "getRootNode", "sendBeacon", "cookie",
  "createElement", "cloneElement", "createPortal", "dangerouslySetInnerHTML", "now",
  "eval", "Function", "fetch", "require", "process", "window", "document", "globalThis", "importScripts",
]);
// Exact string values refused anywhere: names only useful to rebuild a forbidden lookup. Ordinary words ("process",
// "window", "Date") stay usable as caption text; they are refused only as computed keys (checkElementAccess).
const STRING_BANNED = new Set([
  "constructor", "prototype", "__proto__", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__",
  "globalThis", "eval", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "sendBeacon", "innerHTML", "outerHTML",
  "insertAdjacentHTML", "srcdoc", "contentWindow", "contentDocument", "ownerDocument", "defaultView", "createElement",
  "dangerouslySetInnerHTML", "getPrototypeOf", "setPrototypeOf", "defineProperty", "getOwnPropertyDescriptor", "fromCharCode",
  "setTimeout", "setInterval", "requestAnimationFrame", "localStorage", "sessionStorage", "indexedDB", "WebAssembly",
  "SharedArrayBuffer", "__webpack_require__", "__non_webpack_require__",
]);
// Lower-case JSX tags never allowed (script/network/embedding, CSS injection, time-based animation, <img> instead of <Img>).
const FORBIDDEN_TAGS = new Set([
  "script", "iframe", "frame", "frameset", "object", "embed", "applet", "portal", "link", "style", "meta", "base", "form",
  "img", "video", "audio", "source", "track", "picture", "foreignobject", "animate", "animatemotion", "animatetransform",
  "set", "a", "noscript", "template", "slot", "dialog", "marquee", "canvas",
]);
const URL_ATTRS = new Set(["src", "href", "xlinkhref", "srcset", "poster", "action", "formaction", "data", "background", "ping", "manifest", "codebase"]);
// Objects whose members may not be looked up with a computed (non-literal) key.
const GLOBAL_OBJECTS = new Set(["Math", "Object", "Array", "String", "Number", "Boolean", "JSON", "Symbol", "Intl", "Promise", "RegExp", "Error", "Map", "Set", "WeakMap", "WeakSet"]);
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const JSX_IDENT = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;
const STATIC_PATH = /^[A-Za-z0-9_-][A-Za-z0-9_./-]{0,127}$/;
const STATIC_PART = /^[A-Za-z0-9_./-]{0,128}$/;
const COMMENT_DIRECTIVES = ["@ts-", "@jsx", "<reference", "<amd-", "sourcemappingurl", "sourceurl", "webpack", "eslint-disable"];
const TIMERS = new Set(["setTimeout", "setInterval", "requestAnimationFrame", "requestIdleCallback", "setImmediate", "queueMicrotask"]);
const NETWORK = new Set(["fetch", "XMLHttpRequest", "WebSocket", "EventSource"]);

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
  // Names a JSX tag may use: functions, classes and const arrow/function components declared in this file.
  forEachNode(sf, (n) => {
    if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name) components.add(n.name.text);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isVariableDeclarationList(n.parent) && n.parent.flags & ts.NodeFlags.Const) {
      let init: ts.Expression = n.initializer;
      while (ts.isParenthesizedExpression(init)) init = init.expression;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) components.add(n.name.text);
    }
  });

  // Iterative walk: deep nesting cannot overflow the stack. Type-only parts are skipped (erased at compile time).
  const stack: { n: ts.Node; d: number }[] = [{ n: sf, d: 0 }];
  while (stack.length > 0 && problems.length < MAX_PROBLEMS * 2) {
    const { n, d } = stack.pop()!;
    if (d > MAX_DEPTH) { add(n, "the code is nested too deeply."); return; }
    comments(n);
    if (isTypeOnlyNode(n)) continue;
    visit(n);
    const kids: ts.Node[] = [];
    ts.forEachChild(n, (k) => { kids.push(k); });
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ n: kids[i]!, d: d + 1 });
  }
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
      case ts.SyntaxKind.AwaitExpression: return add(n, "await is not allowed: a frame must render synchronously.");
      case ts.SyntaxKind.AsyncKeyword: return add(n, "async functions are not allowed: a frame must render synchronously.");
      case ts.SyntaxKind.TaggedTemplateExpression: return add(n, "tagged templates are not allowed.");
      case ts.SyntaxKind.ElementAccessExpression: return checkElementAccess(n as ts.ElementAccessExpression);
      case ts.SyntaxKind.ComputedPropertyName: { checkComputedKey(n, (n as ts.ComputedPropertyName).expression); return; }
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
        const e = (n as ts.NewExpression).expression;
        if (!ts.isIdentifier(e)) add(n, `'new ${snip(e)}' is not allowed.`);
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
      case ts.SyntaxKind.ClassDeclaration:
      case ts.SyntaxKind.VariableStatement: return checkExported(n as ts.FunctionDeclaration | ts.ClassDeclaration | ts.VariableStatement);
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

  function checkIdentifier(id: ts.Identifier): void {
    const p = id.parent;
    const jsxName = ts.isJsxAttribute(p) || ts.isJsxNamespacedName(p) || ((ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxClosingElement(p)) && p.tagName === id);
    if (!(jsxName ? JSX_IDENT : IDENT).test(id.text) || id.getText(sf) !== id.text) return add(id, "identifiers must be plain ASCII letters, digits, _ or $ (no escapes).");
    const isMemberName = (ts.isPropertyAccessExpression(p) && p.name === id) || (ts.isQualifiedName(p) && p.right === id) ||
      ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) && p.name === id) ||
      jsxName || ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p);
    if (isMemberName) {
      if (FORBIDDEN_MEMBERS.has(id.text)) add(id, `'${echo(id.text)}' is not allowed.`);
      return;
    }
    if (FORBIDDEN_GLOBALS.has(id.text)) add(id, `'${echo(id.text)}' is not allowed${hint(id.text)}.`);
    else if (FORBIDDEN_MEMBERS.has(id.text)) add(id, `'${echo(id.text)}' is not allowed.`);
  }

  function checkPropertyAccess(pa: ts.PropertyAccessExpression): void {
    const obj = pa.expression;
    const name = pa.name.text;
    if (ts.isIdentifier(obj) && obj.text === "Math" && name === "random") add(pa, "Math.random is not allowed; use random('seed') from remotion.");
    if (ts.isIdentifier(obj) && obj.text === REACT_DEFAULT && reactDefault && !TSX_IMPORTS.react!.includes(name)) add(pa, `'React.${echo(name)}' is not allowed (only ${TSX_IMPORTS.react!.join(", ")}).`);
  }

  function checkComputedKey(n: ts.Node, key: ts.Expression): boolean {
    const lit = literalString(key);
    if (lit === undefined) return false;
    if (FORBIDDEN_MEMBERS.has(lit) || FORBIDDEN_GLOBALS.has(lit) || STRING_BANNED.has(lit) || lit === "random") add(n, `the key '${echo(lit)}' is not allowed.`);
    return true;
  }

  function checkElementAccess(ea: ts.ElementAccessExpression): void {
    const key = ea.argumentExpression;
    const obj = ea.expression;
    const lit = literalString(key);
    if (lit !== undefined && ts.isIdentifier(obj) && obj.text === REACT_DEFAULT && reactDefault && !TSX_IMPORTS.react!.includes(lit)) add(ea, `'React.${echo(lit)}' is not allowed (only ${TSX_IMPORTS.react!.join(", ")}).`);
    if (checkComputedKey(ea, key) || ts.isNumericLiteral(key)) return;
    if (ts.isIdentifier(obj) && (GLOBAL_OBJECTS.has(obj.text) || imported.has(obj.text) || obj.text === REACT_DEFAULT)) add(ea, `computed lookup on '${echo(obj.text)}' is not allowed.`);
    else if (containsString(key)) add(ea, "computed keys built from text are not allowed.");
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
  }

  function checkStaticFile(c: ts.CallExpression): void {
    const a = c.arguments.length === 1 ? c.arguments[0]! : undefined;
    let ok = false;
    if (a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))) ok = STATIC_PATH.test(a.text) && !a.text.split("/").some((s) => s === ".." || s === ".");
    else if (a && ts.isTemplateExpression(a)) {
      const parts = [a.head.text, ...a.templateSpans.map((s) => s.literal.text)];
      ok = STATIC_PATH.test(a.head.text) && parts.every((t) => STATIC_PART.test(t) && !t.includes(".."));
    }
    if (!ok) add(c, "staticFile() needs one plain relative file name, e.g. staticFile('assets/a.png').");
  }

  function checkString(n: ts.Node, text: string): void {
    if (STRING_BANNED.has(text)) add(n, `the text '${echo(text)}' is not allowed as a value.`);
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
    for (const run of literalRuns(b)) checkString(b, run);
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
  }
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
function literalRuns(b: ts.BinaryExpression): string[] & { complete?: boolean } {
  const operands: ts.Node[] = [];
  const todo: ts.Node[] = [b];
  while (todo.length > 0) {
    const n = unwrap(todo.pop()!);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) { todo.push(n.right, n.left); continue; }
    operands.push(n);
  }
  const runs: string[] & { complete?: boolean } = [];
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

function containsString(e: ts.Node): boolean {
  let hit = false;
  forEachNode(e, (n) => { if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) hit = true; });
  return hit;
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
