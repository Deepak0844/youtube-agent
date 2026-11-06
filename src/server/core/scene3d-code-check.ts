import ts from "typescript";
import { S3K_API_DTS } from "@/server/core/s3k-kit-dts";
import { echo } from "@/server/core/tsx-check";
import { kitExportNames } from "@/server/core/tsx-kit";

// SECURITY CONTROL (Phase 5e, layer 1 of 4): a static check of ONE model-written 3D scene file (scene.tsx) before it is type-checked,
// staged or drawn. Layers: (1) this checker, (2) the bundler import allow-list in render-entry.mjs, (3) the loopback-only request
// filter of the render page, (4) the macOS sandbox. It works on the TypeScript AST and the compiler's own symbol table (a real scope
// analysis, so shadowing and aliasing cannot hide a global), never on regexes over the code, except for a few raw-text rules.
// It is deliberately strict and ALLOW-LIST based: only five modules import, three.js only by listed names, only a short list of globals
// exists, nothing reaches a global object, a prototype, a computed name, a string-to-code function, a timer, the DOM or the network.
// It is NOT the whole boundary: JavaScript is too dynamic for any static check to be complete (the sandbox exists for that), and a hostile
// file can still be slow (the render has its own time limit). Pure, never throws, input capped before parsing. Every problem reads
// "line N: rule: what is wrong; what to write instead" and goes back to the model as retry feedback; the key sentence comes first.

export const SCENE_MAX_BYTES = 60 * 1024;
export const SCENE_MAX_NODES = 30_000;
export const SCENE_MAX_DEPTH = 120; // AST depth
const MAX_BRACKET_DEPTH = 80; // raw-text pre-check, before the parser sees anything
const MAX_STRING = 2000;
const MAX_PROBLEMS = 20;
const MAX_LOOP = 100_000;
const MAX_LOOP_NEST = 3;
const MAX_ARRAY = 100_000;
const MAX_TYPED = 4_000_000;
const LENGTH_ASSUME = 100_000; // `x.length` in a size or bound is assumed to be this big

const S3K_BANNED = new Set(["Stage", "Captions", "TimeContext", "idResolver", "useHold"]); // the host draws the page and the captions; idResolver would let a scene point the loader at any address; useHold can stall the render
/** The names a scene may import from "s3k": the kit manifest (api.d.ts) minus the host-owned page pieces. */
export const S3K_ALLOWED: readonly string[] = kitExportNames(S3K_API_DTS).filter((n) => !S3K_BANNED.has(n));

const REACT_NAMES = ["useMemo", "useRef", "useCallback", "Fragment"];
const REMOTION_NAMES = ["useCurrentFrame", "useVideoConfig", "interpolate", "interpolateColors", "spring", "Easing", "random"];
const FIBER_NAMES = ["useFrame", "useThree"];
/** Every three.js name a scene may import. Loaders, Cache, ImageUtils, Clock, ShaderMaterial and everything that reads files or time are absent on purpose. */
export const THREE_ALLOWED: readonly string[] = [
  // maths
  "Vector2", "Vector3", "Vector4", "Matrix3", "Matrix4", "Quaternion", "Euler", "Color", "Box2", "Box3", "Sphere", "Plane", "Ray", "Triangle", "Spherical", "Cylindrical", "MathUtils", "Line3",
  // scene graph
  "Object3D", "Group", "Mesh", "InstancedMesh", "Points", "Line", "LineSegments", "LineLoop", "Sprite", "LOD", "Fog", "FogExp2",
  // geometry
  "BufferGeometry", "BufferAttribute", "Float32BufferAttribute", "Uint16BufferAttribute", "Uint32BufferAttribute", "InstancedBufferAttribute", "InstancedBufferGeometry",
  "BoxGeometry", "SphereGeometry", "CylinderGeometry", "ConeGeometry", "CapsuleGeometry", "CircleGeometry", "PlaneGeometry", "RingGeometry", "TorusGeometry", "TorusKnotGeometry",
  "ExtrudeGeometry", "LatheGeometry", "ShapeGeometry", "TubeGeometry", "PolyhedronGeometry", "IcosahedronGeometry", "OctahedronGeometry", "TetrahedronGeometry", "DodecahedronGeometry",
  "EdgesGeometry", "WireframeGeometry", "Shape", "Path", "CatmullRomCurve3", "CubicBezierCurve3", "QuadraticBezierCurve3", "LineCurve3", "CurvePath", "EllipseCurve",
  // materials
  "MeshStandardMaterial", "MeshBasicMaterial", "MeshPhysicalMaterial", "MeshLambertMaterial", "MeshPhongMaterial", "MeshToonMaterial", "MeshNormalMaterial", "PointsMaterial",
  "LineBasicMaterial", "LineDashedMaterial", "SpriteMaterial", "ShadowMaterial",
  // textures from canvases and numbers only
  "CanvasTexture", "DataTexture", "Texture",
  // lights and cameras
  "AmbientLight", "DirectionalLight", "PointLight", "SpotLight", "HemisphereLight", "PerspectiveCamera", "OrthographicCamera",
  // constants
  "DoubleSide", "FrontSide", "BackSide", "RepeatWrapping", "ClampToEdgeWrapping", "MirroredRepeatWrapping", "LinearFilter", "NearestFilter", "LinearMipmapLinearFilter", "SRGBColorSpace", "NoColorSpace",
  "NormalBlending", "AdditiveBlending", "MultiplyBlending", "SubtractiveBlending", "RGBAFormat", "RGBFormat", "RedFormat", "UnsignedByteType", "FloatType", "DynamicDrawUsage", "StaticDrawUsage",
  "PCFShadowMap", "PCFSoftShadowMap", "AlwaysDepth", "LessEqualDepth",
];
const THREE_SET = new Set(THREE_ALLOWED);
const LOADER_NOTE = "scenes cannot load files; use useModels(ids, resolver) for catalogue models and CanvasTexture, DataTexture or the s3k texture helpers for pictures";

const MODULE_NAMES: Readonly<Record<string, ReadonlySet<string>>> = {
  react: new Set(REACT_NAMES), remotion: new Set(REMOTION_NAMES), "@react-three/fiber": new Set(FIBER_NAMES), three: THREE_SET, s3k: new Set(S3K_ALLOWED),
};

// Globals a scene may name; everything else must be a local, an import or a React/three name. NO Object.prototype walking, JSON, Reflect, Proxy, Symbol, timers, DOM, URL, Intl, RegExp.
const GLOBAL_MEMBERS: Readonly<Record<string, ReadonlySet<string>>> = {
  Math: new Set(["PI", "E", "LN2", "LN10", "LOG2E", "LOG10E", "SQRT2", "SQRT1_2", "abs", "acos", "acosh", "asin", "asinh", "atan", "atan2", "atanh", "cbrt", "ceil", "clz32", "cos", "cosh", "exp", "expm1", "floor", "fround", "hypot", "imul", "log", "log10", "log1p", "log2", "max", "min", "pow", "round", "sign", "sin", "sinh", "sqrt", "tan", "tanh", "trunc"]),
  Number: new Set(["isFinite", "isInteger", "isNaN", "isSafeInteger", "parseFloat", "parseInt", "EPSILON", "MAX_SAFE_INTEGER", "MIN_SAFE_INTEGER", "MAX_VALUE", "MIN_VALUE", "POSITIVE_INFINITY", "NEGATIVE_INFINITY"]),
  Array: new Set(["isArray", "from", "of"]),
  Object: new Set(["keys", "values", "entries", "fromEntries", "assign", "freeze"]),
  String: new Set([]), Boolean: new Set([]), Error: new Set([]),
};
const CALLABLE_GLOBALS = new Set(["Number", "String", "Boolean", "Array", "parseFloat", "parseInt", "isNaN", "isFinite"]);
const TYPED_ARRAYS = ["Float32Array", "Float64Array", "Uint8Array", "Uint8ClampedArray", "Uint16Array", "Uint32Array", "Int8Array", "Int16Array", "Int32Array"];
const NEWABLE_GLOBALS = new Set(["Array", "Error", "Map", "Set", "WeakMap", "WeakSet", ...TYPED_ARRAYS]);
const SAFE_GLOBALS = new Set(["Math", "Number", "String", "Boolean", "Array", "Object", "Error", "Map", "Set", "WeakMap", "WeakSet", "parseFloat", "parseInt", "isNaN", "isFinite", ...TYPED_ARRAYS]);
const ALWAYS_OK = new Set(["undefined", "NaN", "Infinity"]);
const AS_ARGUMENT_OK = new Set(["Boolean", "Number", "String"]); // arr.filter(Boolean), arr.map(Number)
const GLOBAL_OBJECT_NAMES = new Set(["globalthis", "window", "self", "top", "parent", "frames", "global", "opener"]);

// Member names refused on anything (prototype walking, DOM escape hatches, file/network readers, string growth, GLSL injection). Lower case.
const BANNED_MEMBERS = new Set([
  "constructor", "prototype", "__proto__", "__definegetter__", "__definesetter__", "__lookupgetter__", "__lookupsetter__", "getprototypeof", "setprototypeof", "defineproperty", "defineproperties",
  "getownpropertydescriptor", "getownpropertydescriptors", "caller", "callee", "arguments",
  "src", "srcset", "srcdoc", "href", "setattribute", "setattributens", "innerhtml", "outerhtml", "insertadjacenthtml", "createelement", "createelementns", "appendchild", "append", "insertbefore", "replacechild",
  "domelement", "canvas", "ownerdocument", "closest", "children", "childnodes", "firstchild", "lastchild", "nextsibling", "previoussibling", "firstelementchild", "lastelementchild", "nextelementsibling", "previouselementsibling", "offsetparent", "queryselector", "queryselectorall", "getelementbyid", "getelementsbytagname", "getelementsbyclassname", "shadowroot", "attachshadow", "ownerdocument", "parentnode", "parentelement", "getrootnode", "defaultview", "contentwindow", "contentdocument", "cookie", "sendbeacon", "postmessage", "importscripts",
  "onbeforecompile", "customprogramcachekey", "fromcharcode", "fromcodepoint", "raw", "repeat", "padstart", "padend", "tobase64", "frombase64",
  "random", "now", "gettime", "performance", "eval", "function", "fetch", "require", "process", "window", "document", "globalthis", "self",
]);
const BANNED_MEMBER_HINT: Record<string, string> = {
  random: "use rnd(seed) from s3k: frames must repeat", now: "time comes from useT()", repeat: "repeat(n) needs a constant n of at most 1000", src: "scenes cannot load or set image or file addresses",
  constructor: "use plain values and functions", prototype: "use plain values and functions", __proto__: "use plain values and functions", domelement: "scenes cannot touch the page",
};
// String values refused anywhere (lower case): names only useful to rebuild a forbidden lookup.
const BANNED_STRINGS = new Set(["constructor", "prototype", "__proto__", "globalthis"]);
const URL_LIKE = /(?:\b(?:https?|wss?|ftp|file|blob|javascript|vbscript|chrome|about):|\bdata:[a-z/+.-]*[;,]|^\s*\/\/[a-z0-9.-])/i;
const RAW_DIRECTIVES = ["@ts-", "<reference", "sourcemappingurl", "sourceurl", "webpack", "eslint", "@jsx", "@vite", "</script", "<!--"];

// The ONLY lower-case JSX tags (react-three-fiber elements for three.js classes in the allow-list). No HTML: the host draws all HTML.
const R3F_TAGS = new Set([
  "group", "mesh", "instancedMesh", "points", "line", "lineSegments", "lineLoop", "sprite", "object3D", "primitive", "lOD",
  "ambientLight", "directionalLight", "pointLight", "spotLight", "hemisphereLight", "fog", "fogExp2", "color",
  "bufferGeometry", "bufferAttribute", "float32BufferAttribute", "boxGeometry", "sphereGeometry", "cylinderGeometry", "coneGeometry", "capsuleGeometry", "circleGeometry",
  "planeGeometry", "ringGeometry", "torusGeometry", "torusKnotGeometry", "extrudeGeometry", "latheGeometry", "shapeGeometry", "tubeGeometry", "icosahedronGeometry", "octahedronGeometry",
  "tetrahedronGeometry", "dodecahedronGeometry", "edgesGeometry", "wireframeGeometry",
  "meshStandardMaterial", "meshBasicMaterial", "meshPhysicalMaterial", "meshLambertMaterial", "meshPhongMaterial", "meshToonMaterial", "meshNormalMaterial", "pointsMaterial",
  "lineBasicMaterial", "lineDashedMaterial", "spriteMaterial", "shadowMaterial", "canvasTexture", "dataTexture", "texture",
]);
const TAG_HINT: Record<string, string> = {
  script: "scripts cannot run in a scene", img: "scenes cannot load pictures", iframe: "scenes cannot embed pages", style: "scenes cannot add CSS", link: "scenes cannot load files", video: "scenes cannot play video",
  audio: "the host plays the sound", object: "scenes cannot embed files", embed: "scenes cannot embed files", textureloader: "scenes cannot load files", svg: "the host draws all HTML and SVG",
};
const BANNED_ATTRS = new Set(["dangerouslysetinnerhtml", "src", "srcset", "srcdoc", "href", "xlinkhref", "onbeforecompile", "customprogramcachekey", "action", "formaction", "poster", "data"]);
const ITERATORS = new Set(["map", "filter", "reduce", "reduceRight", "forEach", "some", "every", "find", "findIndex", "findLast", "findLastIndex", "flatMap", "sort", "toSorted"]);
const GROWERS = new Set(["push", "unshift", "splice"]);
const ASSIGN_OPS = new Set([
  ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken, ts.SyntaxKind.LessThanLessThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanEqualsToken, ts.SyntaxKind.AmpersandEqualsToken, ts.SyntaxKind.BarEqualsToken, ts.SyntaxKind.CaretEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
]);

export interface SceneCheckResult {
  ok: boolean;
  problems: string[];
}

const fail = (problems: string[]): SceneCheckResult => ({ ok: false, problems: [...new Set(problems)].slice(0, MAX_PROBLEMS) });

// ---------- the in-memory compiler program (symbols and types only; nothing is emitted, nothing but the default library is read) ----------

const FILE = "/scene3d/scene.tsx";
const OPTIONS: ts.CompilerOptions = {
  noEmit: true, target: ts.ScriptTarget.ES2022, lib: ["lib.es2022.d.ts"], types: [], jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  noResolve: true, skipLibCheck: true, allowJs: false, isolatedModules: true,
};
const libCache = new Map<string, ts.SourceFile>();

function program(source: string): ts.Program {
  const host = ts.createCompilerHost(OPTIONS, true);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (f, lang, onError, create) => {
    if (f === FILE) return ts.createSourceFile(f, source, lang, true, ts.ScriptKind.TSX);
    let sf = libCache.get(f);
    if (!sf) {
      sf = read(f, lang, onError, create);
      if (sf) libCache.set(f, sf);
    }
    return sf;
  };
  host.fileExists = (f) => f === FILE || ts.sys.fileExists(f);
  host.readFile = (f) => (f === FILE ? source : ts.sys.readFile(f));
  host.writeFile = () => undefined;
  host.resolveModuleNameLiterals = (literals) => literals.map(() => ({ resolvedModule: undefined }));
  return ts.createProgram({ rootNames: [FILE], options: OPTIONS, host });
}

/** Statically checks one AI-written 3D scene file. Never throws; the problems are short, plain and safe to echo back. */
export function checkScene3dCode(source: unknown): SceneCheckResult {
  try {
    if (typeof source !== "string") return fail(["file: the scene must be text; send the whole scene.tsx source."]);
    if (source.length > SCENE_MAX_BYTES || Buffer.byteLength(source, "utf8") > SCENE_MAX_BYTES) return fail([`size: the file is bigger than ${SCENE_MAX_BYTES / 1024} KB; write a shorter scene.`]);
    if (source.trim() === "") return fail(["file: the file is empty; send the whole scene."]);
    for (let i = 0; i < source.length; i++) {
      const c = source.charCodeAt(i);
      if (!(c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127))) return fail([`characters: line ${source.slice(0, i).split("\n").length} has a character that is not plain ASCII; use plain printable ASCII only (no accents, emoji or hidden characters).`]);
    }
    const low = source.toLowerCase();
    for (const d of RAW_DIRECTIVES) if (low.includes(d)) return fail([`text: the file contains "${d}", which is not allowed anywhere in a scene, even in a comment; remove it.`]);
    let depth = 0, max = 0;
    for (const ch of source) {
      if (ch === "(" || ch === "[" || ch === "{") max = Math.max(max, ++depth);
      else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    }
    if (max > MAX_BRACKET_DEPTH) return fail([`nesting: brackets are nested ${max} deep; keep it under ${MAX_BRACKET_DEPTH}. Split the code into small functions.`]);
    return run(source);
  } catch {
    return fail(["file: the file could not be checked; write simpler code."]);
  }
}

function run(source: string): SceneCheckResult {
  const prog = program(source);
  const sf = prog.getSourceFile(FILE);
  if (!sf) return fail(["file: the file could not be read; send valid TSX."]);
  const syntax = prog.getSyntacticDiagnostics(sf);
  if (syntax.length > 0) {
    return fail(syntax.slice(0, 3).map((d) => `line ${d.start === undefined ? "?" : sf.getLineAndCharacterOfPosition(d.start).line + 1}: syntax: ${echo(ts.flattenDiagnosticMessageText(d.messageText, " "))}; fix it so the file parses.`));
  }
  const checker = prog.getTypeChecker();
  const problems: string[] = [];
  const add = (n: ts.Node, text: string) => {
    if (problems.length < MAX_PROBLEMS * 3) problems.push(`line ${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}: ${text}`.slice(0, 260));
  };
  const isLibDecl = (d: ts.Declaration) => prog.isSourceFileDefaultLibrary(d.getSourceFile());

  /** The module and kind of an import binding, or undefined when the symbol is not an import. */
  const importInfo = (sym: ts.Symbol): { module: string; ns: boolean } | undefined => {
    const d = sym.declarations?.[0];
    if (!d) return undefined;
    const decl = ts.findAncestor(d, ts.isImportDeclaration);
    if (!decl || !ts.isStringLiteral(decl.moduleSpecifier)) return undefined;
    return { module: decl.moduleSpecifier.text, ns: ts.isNamespaceImport(d) || ts.isImportClause(d) };
  };
  const evalNum = (e: ts.Expression, seen = 0): number | undefined => {
    if (seen > 12) return undefined;
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) return evalNum(e.expression, seen + 1);
    if (ts.isNumericLiteral(e)) return Number(e.text);
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken) { const v = evalNum(e.operand, seen + 1); return v === undefined ? undefined : -v; }
    if (ts.isPropertyAccessExpression(e) && e.name.text === "length") return LENGTH_ASSUME;
    if (ts.isIdentifier(e)) {
      const d = checker.getSymbolAtLocation(e)?.declarations?.[0];
      if (d && ts.isVariableDeclaration(d) && d.initializer && ts.isVariableDeclarationList(d.parent) && (d.parent.flags & ts.NodeFlags.Const) !== 0) return evalNum(d.initializer, seen + 1);
      return undefined;
    }
    if (ts.isBinaryExpression(e)) {
      const a = evalNum(e.left, seen + 1), b = evalNum(e.right, seen + 1);
      if (a === undefined || b === undefined) return undefined;
      switch (e.operatorToken.kind) {
        case ts.SyntaxKind.PlusToken: return a + b;
        case ts.SyntaxKind.MinusToken: return a - b;
        case ts.SyntaxKind.AsteriskToken: return a * b;
        case ts.SyntaxKind.SlashToken: return b === 0 ? undefined : a / b;
        case ts.SyntaxKind.PercentToken: return b === 0 ? undefined : a % b;
        default: return undefined;
      }
    }
    return undefined;
  };
  const literalKey = (e: ts.Expression): string | undefined => (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) ? e.text : undefined);
  // Layer 1 does NOT use TypeScript type information for this: a "number" type can be a lie (casts, any, generics, overloads, declarations).
  // A computed index is allowed only when it is a number BY SYNTAX, and the indexed thing is a locally declared array.
  const counters = new Set<ts.Symbol>(); // loop counters proven by checkFor (constant bounds, body never writes them)
  const unwrap = (e: ts.Expression): ts.Expression => {
    let x = e;
    while (ts.isParenthesizedExpression(x)) x = x.expression;
    return x;
  };
  const NUMERIC_MATH = new Set(["floor", "ceil", "round", "trunc", "min", "max", "abs"]);
  /** localArray: an array literal, or a local variable initialised with one (or new Array(..), Array(..), a typed array, Array.from/of). */
  const localArray = (e: ts.Expression): boolean => {
    const x = unwrap(e);
    if (ts.isArrayLiteralExpression(x)) return true;
    if (!ts.isIdentifier(x)) return false;
    const d = checker.getSymbolAtLocation(x)?.declarations?.[0];
    if (!d || !ts.isVariableDeclaration(d) || !d.initializer) return false;
    let init = unwrap(d.initializer);
    while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init)) init = unwrap(init.expression);
    if (ts.isArrayLiteralExpression(init)) return true;
    if (ts.isNewExpression(init) || ts.isCallExpression(init)) {
      const c = init.expression;
      const libName = (id: ts.Identifier): boolean => (id.text === "Array" || TYPED_ARRAYS.includes(id.text)) && (checker.getSymbolAtLocation(id)?.declarations ?? []).length > 0 && (checker.getSymbolAtLocation(id)?.declarations ?? []).every(isLibDecl);
      if (ts.isIdentifier(c)) return libName(c);
      return ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && libName(c.expression) && c.expression.text === "Array" && (c.name.text === "from" || c.name.text === "of");
    }
    return false;
  };
  /** True only for: a number literal, a proven loop counter, a const of such an expression, + - * / % of such, Math.floor/ceil/round/trunc/min/max/abs of such, and .length of a local array. */
  const numericSyntax = (e: ts.Expression, depth = 0): boolean => {
    if (depth > 8) return false;
    const x = unwrap(e);
    if (ts.isNumericLiteral(x)) return true;
    if (ts.isPrefixUnaryExpression(x) && (x.operator === ts.SyntaxKind.MinusToken || x.operator === ts.SyntaxKind.PlusToken)) return numericSyntax(x.operand, depth + 1);
    if (ts.isBinaryExpression(x)) {
      const k = x.operatorToken.kind;
      return (k === ts.SyntaxKind.PlusToken || k === ts.SyntaxKind.MinusToken || k === ts.SyntaxKind.AsteriskToken || k === ts.SyntaxKind.SlashToken || k === ts.SyntaxKind.PercentToken) && numericSyntax(x.left, depth + 1) && numericSyntax(x.right, depth + 1);
    }
    if (ts.isIdentifier(x)) {
      const sym = checker.getSymbolAtLocation(x);
      if (!sym) return false;
      if (counters.has(sym)) return true;
      const d = sym.declarations?.[0];
      return !!d && ts.isVariableDeclaration(d) && !!d.initializer && ts.isVariableDeclarationList(d.parent) && (d.parent.flags & ts.NodeFlags.Const) !== 0 && ts.isIdentifier(d.name) && numericSyntax(d.initializer, depth + 1);
    }
    if (ts.isPropertyAccessExpression(x)) return x.name.text === "length" && localArray(x.expression);
    if (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression) && ts.isIdentifier(x.expression.expression) && x.expression.expression.text === "Math" && NUMERIC_MATH.has(x.expression.name.text)) {
      const msym = checker.getSymbolAtLocation(x.expression.expression);
      const lib = !msym || (msym.declarations ?? []).every(isLibDecl);
      return lib && x.arguments.length >= 1 && x.arguments.every((a) => numericSyntax(a, depth + 1));
    }
    return false;
  };
  /** `a[i]`: i provably numeric by syntax and `a` a locally declared array. `{ [i]: v }`: i provably numeric. Text keys, casts and everything else: refused. */
  const checkKey = (key: ts.Expression, owner: ts.Node, object?: ts.Expression) => {
    const lit = literalKey(key);
    if (lit !== undefined) return add(owner, `computed key: ["${echo(lit)}"] is not allowed; write the name with a dot (obj.name) instead.`);
    if (!numericSyntax(key)) return add(owner, "computed key: an index [..] must be a number literal, a for-loop counter, simple arithmetic of those, or Math.floor/min/max of those; a text key could reach forbidden members. Use obj.name or an array index.");
    if (object && !ts.isNumericLiteral(unwrap(key)) && !localArray(object)) add(owner, "computed key: only a locally declared array (const a = [..] or new Float32Array(n)) may be indexed with a counter or arithmetic (a number literal like out[0] works on anything); use .name for objects.");
  };

  // --- pass 1: collect functions and loops (call graph for recursion, loop counters), then the main walk ---
  const edges = new Map<ts.Node, Set<ts.Node>>();
  const fnStack: ts.Node[] = [];

  let nodes = 0;
  let loopDepth = 0;
  let loopProduct = 1;
  let cbDepth = 0;
  let defaultExports = 0;
  const importedSeen = new Set<string>();

  /** True when this identifier occurrence is written to: any assignment operator (incl. ||= &&= ??= >>>=), ++/--, delete, a destructuring or array/object-literal target, a for-of/for-in initialiser. */
  const isWritten = (id: ts.Identifier): boolean => {
    let node: ts.Node = id;
    for (;;) {
      const p = node.parent;
      if (!p) return false;
      if (ts.isParenthesizedExpression(p) || ts.isArrayLiteralExpression(p) || ts.isSpreadElement(p) || ts.isSpreadAssignment(p) || ts.isNonNullExpression(p) || ts.isAsExpression(p) || ts.isSatisfiesExpression(p)) { node = p; continue; }
      if (ts.isShorthandPropertyAssignment(p)) { if (p.name !== node) return false; node = p; continue; }
      if (ts.isPropertyAssignment(p)) { if (p.initializer !== node) return false; node = p; continue; }
      if (ts.isObjectLiteralExpression(p)) { node = p; continue; }
      if (ts.isBinaryExpression(p) && p.left === node) {
        const k = p.operatorToken.kind;
        if (k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment) return true;
        return false;
      }
      if ((ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) && (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken)) return true;
      if (ts.isDeleteExpression(p)) return true;
      if ((ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.initializer === node) return true;
      if (ts.isBindingElement(p) && p.name === node) return true;
      return false;
    }
  };
  /** True when the symbol is written anywhere in the WHOLE file (closures included) other than inside `except` (the loop's own incrementor). */
  const writtenOutside = (sym: ts.Symbol, except: ts.Node): boolean => {
    let hit = false;
    const visit = (n: ts.Node) => {
      if (hit) return;
      if (n === except) return;
      if (ts.isIdentifier(n) && checker.getSymbolAtLocation(n) === sym && isWritten(n)) { hit = true; return; }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return hit;
  };
  const growsArray = (root: ts.Node, sym: ts.Symbol): boolean => {
    let hit = false;
    const visit = (n: ts.Node) => {
      if (hit) return;
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && GROWERS.has(n.expression.name.text) && ts.isIdentifier(n.expression.expression) && checker.getSymbolAtLocation(n.expression.expression) === sym) { hit = true; return; }
      if (ts.isBinaryExpression(n) && ASSIGN_OPS.has(n.operatorToken.kind) && ts.isPropertyAccessExpression(n.left) && ts.isIdentifier(n.left.expression) && checker.getSymbolAtLocation(n.left.expression) === sym) { hit = true; return; }
      ts.forEachChild(n, visit);
    };
    visit(root);
    return hit;
  };

  /** `for (let i = A; i < B; i++)` with constant A, B (B <= MAX_LOOP) and a body that never writes i. Returns the iteration bound, or undefined (a problem was added). */
  const checkFor = (n: ts.ForStatement): number => {
    const bad = (why: string) => { add(n, `loop: ${why}; write for (let i = 0; i < 100; i++) with a constant bound of at most ${MAX_LOOP}.`); return MAX_LOOP; };
    const init = n.initializer;
    if (!init || !ts.isVariableDeclarationList(init) || init.declarations.length !== 1) return bad("a for loop needs one counter, e.g. let i = 0");
    const d = init.declarations[0]!;
    if (!(init.flags & ts.NodeFlags.Let) || (init.flags & ts.NodeFlags.Const)) return bad("the counter must be declared with let (not var)");
    if (!ts.isIdentifier(d.name) || !d.initializer) return bad("a for loop needs one counter starting at a number");
    const start = evalNum(d.initializer);
    if (start === undefined) return bad("the counter must start at a constant number");
    const sym = checker.getSymbolAtLocation(d.name);
    const c = n.condition, inc = n.incrementor;
    if (!sym || !c || !inc) return bad("an unbounded for loop (missing condition or step) is not allowed");
    if (!ts.isBinaryExpression(c) || !ts.isIdentifier(c.left) || checker.getSymbolAtLocation(c.left) !== sym) return bad("the loop condition must compare the counter, e.g. i < 100");
    const op = c.operatorToken.kind;
    const up = op === ts.SyntaxKind.LessThanToken || op === ts.SyntaxKind.LessThanEqualsToken;
    const down = op === ts.SyntaxKind.GreaterThanToken || op === ts.SyntaxKind.GreaterThanEqualsToken;
    if (!up && !down) return bad("the loop condition must be i < N, i <= N, i > N or i >= N");
    const bound = evalNum(c.right);
    if (bound === undefined) return bad("the loop bound must be a constant (a number, or a const made of numbers)");
    if (ts.isPropertyAccessExpression(c.right) && ts.isIdentifier(c.right.expression)) {
      const arr = checker.getSymbolAtLocation(c.right.expression);
      if (arr && growsArray(n.statement, arr)) return bad("the loop grows the array it counts to, so it may never end");
    }
    let stepOk = false;
    if ((ts.isPrefixUnaryExpression(inc) || ts.isPostfixUnaryExpression(inc)) && ts.isIdentifier(inc.operand) && checker.getSymbolAtLocation(inc.operand) === sym) {
      stepOk = up ? inc.operator === ts.SyntaxKind.PlusPlusToken : inc.operator === ts.SyntaxKind.MinusMinusToken;
    } else if (ts.isBinaryExpression(inc) && ts.isIdentifier(inc.left) && checker.getSymbolAtLocation(inc.left) === sym) {
      const k = evalNum(inc.right);
      stepOk = k !== undefined && k > 0 && (up ? inc.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken : inc.operatorToken.kind === ts.SyntaxKind.MinusEqualsToken);
    }
    if (!stepOk) return bad("the step must move the counter towards the bound (i++, i += 2 or i--)");
    if (writtenOutside(sym, inc)) return bad("the loop counter is changed somewhere other than its own i++ step (anywhere in the file, closures included)");
    const count = Math.abs(bound - start) + 1;
    if (!(count <= MAX_LOOP)) return bad(`the loop runs about ${Math.round(count)} times`);
    counters.add(sym);
    return count;
  };

  /** The ONE allowed use of the page: document.createElement("canvas") (a canvas for a texture; it is never attached to the page). */
  const isCanvasCreate = (a: ts.PropertyAccessExpression): boolean =>
    ts.isIdentifier(a.expression) && a.expression.text === "document" && a.name.text === "createElement" && ts.isCallExpression(a.parent) && a.parent.expression === a && a.parent.arguments.length === 1 && literalKey(a.parent.arguments[0]!) === "canvas";

  const isImportSpecifierName = (n: ts.Identifier) => ts.isImportSpecifier(n.parent) || ts.isImportClause(n.parent);
  /** The resolver must be the scene's own `resolver` prop: a parameter (or a binding of the parameter's destructuring) or p.resolver of a parameter; never a value built in the scene. */
  const defaultFn = (): ts.Node | undefined => {
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) return st;
      if (ts.isExportAssignment(st) && !st.isExportEquals) {
        const x = st.expression;
        if (ts.isArrowFunction(x) || ts.isFunctionExpression(x)) return x;
        const d = ts.isIdentifier(x) ? checker.getSymbolAtLocation(x)?.declarations?.[0] : undefined;
        if (d && ts.isFunctionDeclaration(d)) return d;
        if (d && ts.isVariableDeclaration(d) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) return d.initializer;
      }
    }
    return undefined;
  };
  const isHostResolver = (e: ts.Expression | undefined): boolean => {
    if (!e) return false;
    const top = defaultFn();
    const ofTop = (d: ts.Node): boolean => {
      const prm = ts.findAncestor(d, ts.isParameter);
      return !!prm && !!top && prm.parent === top;
    };
    const fromParam = (id: ts.Identifier): boolean => {
      const d = checker.getSymbolAtLocation(id)?.declarations?.[0];
      if (!d) return false;
      if (ts.isParameter(d)) return !d.initializer && ofTop(d);
      return ts.isBindingElement(d) && !d.initializer && ofTop(d) && ts.isIdentifier(d.name) && (d.propertyName ? ts.isIdentifier(d.propertyName) && d.propertyName.text === "resolver" : d.name.text === "resolver");
    };
    if (ts.isIdentifier(e)) return fromParam(e);
    return ts.isPropertyAccessExpression(e) && e.name.text === "resolver" && ts.isIdentifier(e.expression) && fromParam(e.expression);
  };

  /** True for an object literal that is the target of an assignment or a for-of: ({ a, b } = x), for ({ a } of xs). */
  const isAssignmentPattern = (lit: ts.Node): boolean => {
    let node: ts.Node = lit;
    while (node.parent && (ts.isPropertyAssignment(node.parent) || ts.isShorthandPropertyAssignment(node.parent) || ts.isArrayLiteralExpression(node.parent) || ts.isSpreadElement(node.parent) || ts.isParenthesizedExpression(node.parent) || ts.isSpreadAssignment(node.parent) || ts.isObjectLiteralExpression(node.parent))) node = node.parent;
    const p = node.parent;
    return !!p && ((ts.isBinaryExpression(p) && ASSIGN_OPS.has(p.operatorToken.kind) && p.left === node) || ((ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.initializer === node));
  };

  const globalUse = (n: ts.Identifier) => {
    const name = n.text;
    const p = n.parent;
    if (name === "document" && ts.isPropertyAccessExpression(p) && p.expression === n && isCanvasCreate(p)) return;
    if (GLOBAL_OBJECT_NAMES.has(name.toLowerCase())) return add(n, `global: "${name}" is the global object; scenes cannot reach it. Use only the s3k kit and three.js imports.`);
    if (!SAFE_GLOBALS.has(name)) {
      const net = ["fetch", "xmlhttprequest", "websocket", "eventsource", "navigator", "worker", "sharedworker", "broadcastchannel", "indexeddb", "localstorage", "sessionstorage", "location", "history", "image", "audio", "video", "open", "close", "alert", "importscripts", "postmessage"].includes(name.toLowerCase());
      return add(n, `global: "${name}" is not available in a scene${net ? "; scenes cannot use the network, storage, windows or media" : ""}. Use the s3k kit, three.js imports, Math and plain JavaScript values.`);
    }
    if (ts.isPropertyAccessExpression(p) && p.expression === n) {
      const allowed = GLOBAL_MEMBERS[name];
      if (allowed && !allowed.has(p.name.text)) add(n, `global: ${name}.${echo(p.name.text)} is not allowed; ${name} offers only ${[...allowed].slice(0, 6).join(", ")}${allowed.size > 6 ? ", ..." : ""}.`);
      else if (!allowed) add(n, `global: ${name} may only be used as new ${name}(...); no members.`);
      return;
    }
    if (ts.isElementAccessExpression(p) && p.expression === n) return add(n, `global: ${name}[...] is not allowed; use ${name}.name.`);
    if (ts.isCallExpression(p) && p.expression === n) return CALLABLE_GLOBALS.has(name) ? undefined : add(n, `global: ${name}(...) cannot be called; use new ${name}(...).`);
    if (ts.isNewExpression(p) && p.expression === n) return NEWABLE_GLOBALS.has(name) ? undefined : add(n, `global: new ${name}() is not allowed.`);
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && p.right === n) return;
    if (ts.isTypeOfExpression(p)) return;
    if (AS_ARGUMENT_OK.has(name) && ts.isCallExpression(p) && p.arguments.includes(n)) return;
    add(n, `global: ${name} may only be used as ${name}.name or ${name}(...); do not alias or pass it around.`);
  };

  const refSymbol = (n: ts.Identifier): ts.Symbol | undefined => {
    const p = n.parent;
    if (ts.isShorthandPropertyAssignment(p) && p.name === n) return checker.getShorthandAssignmentValueSymbol(p);
    return checker.getSymbolAtLocation(n);
  };
  /** True when this identifier is a plain name, not a reference to a binding (property names, attribute names, import/export names). */
  const isNameOnly = (n: ts.Identifier): boolean => {
    const p = n.parent;
    return (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isQualifiedName(p) && p.right === n) || (ts.isPropertyAssignment(p) && p.name === n) || (ts.isJsxAttribute(p) && p.name === n)
      || (ts.isMethodDeclaration(p) && p.name === n) || (ts.isPropertySignature(p) && p.name === n) || (ts.isBindingElement(p) && p.propertyName === n) || (ts.isImportSpecifier(p) && p.propertyName === n)
      || (ts.isExportSpecifier(p) && p.propertyName === n) || (ts.isPropertyDeclaration(p) && p.name === n) || ts.isMetaProperty(p)
      || ((ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxClosingElement(p)) && p.tagName === n && /^[a-z]/.test(n.text));
  };

  const checkImport = (n: ts.ImportDeclaration) => {
    const mod = ts.isStringLiteral(n.moduleSpecifier) ? n.moduleSpecifier.text : "";
    const allowed = MODULE_NAMES[mod];
    const clause = n.importClause;
    if (!allowed) return add(n, `import: "${echo(mod)}" is not an allowed module; scenes may import only react, remotion, three, @react-three/fiber and s3k (the kit).`);
    if (!clause) return add(n, `import: a bare import of "${mod}" is not allowed; import the names you use.`);
    if (clause.isTypeOnly) return; // erased: no value reaches the scene
    if (clause.name && !(mod === "react" || mod === "three" || mod === "s3k")) add(n, `import: "${mod}" has no default import; use named imports.`);
    const b = clause.namedBindings;
    if (b && ts.isNamespaceImport(b) && !(mod === "three" || mod === "s3k" || mod === "react")) add(n, `import: use named imports from "${mod}", not import * as.`);
    if (b && ts.isNamedImports(b)) {
      for (const el of b.elements) {
        if (el.isTypeOnly) continue;
        const name = (el.propertyName ?? el.name).text;
        if (allowed.has(name)) continue;
        if (mod === "three") add(el, /loader|cache|imageutils/i.test(name) ? `import: three "${name}" is a loader or file reader; ${LOADER_NOTE}.` : `import: three "${echo(name)}" is not on the allow-list (geometries, standard materials, maths, lights, CanvasTexture and DataTexture are).`);
        else add(el, `import: "${echo(name)}" is not exported by ${mod} for scenes${mod === "s3k" ? "; use only names from the kit API reference" : ""}.`);
      }
    }
    importedSeen.add(mod);
  };

  const enter = (n: ts.Node) => {
    switch (n.kind) {
      case ts.SyntaxKind.ClassDeclaration: case ts.SyntaxKind.ClassExpression: add(n, "class: classes are not allowed; use plain functions and objects."); break;
      case ts.SyntaxKind.ThisKeyword: add(n, 'this: "this" is not allowed; use plain functions and objects.'); break;
      case ts.SyntaxKind.WithStatement: add(n, "with: the with statement is not allowed."); break;
      case ts.SyntaxKind.LabeledStatement: add(n, "label: labels are not allowed; write a plain for loop."); break;
      case ts.SyntaxKind.DebuggerStatement: add(n, "debugger: not allowed."); break;
      case ts.SyntaxKind.WhileStatement: case ts.SyntaxKind.DoStatement: add(n, "loop: while and do loops are not allowed; write for (let i = 0; i < N; i++) with a constant N."); break;
      case ts.SyntaxKind.ForInStatement: add(n, "loop: for...in is not allowed; use for...of over an array, or a counter loop."); break;
      case ts.SyntaxKind.YieldExpression: case ts.SyntaxKind.AwaitExpression: add(n, "async: yield, await, async and generators are not allowed; a scene is plain synchronous code."); break;
      case ts.SyntaxKind.GetAccessor: case ts.SyntaxKind.SetAccessor: add(n, "accessor: get and set accessors are not allowed; use plain properties."); break;
      case ts.SyntaxKind.Decorator: add(n, "decorator: decorators are not allowed."); break;
      case ts.SyntaxKind.EnumDeclaration: case ts.SyntaxKind.ModuleDeclaration: add(n, "declaration: enum, namespace and declare module are not allowed; use plain consts and types."); break;
      case ts.SyntaxKind.ImportEqualsDeclaration: add(n, "import: import = require(...) is not allowed."); break;
      case ts.SyntaxKind.MetaProperty: add(n, "meta: import.meta and new.target are not allowed."); break;
      case ts.SyntaxKind.TaggedTemplateExpression: add(n, "template: tagged templates are not allowed; use a plain template string."); break;
      case ts.SyntaxKind.RegularExpressionLiteral: add(n, "regex: regular expressions are not allowed (they can hang); use plain string and number code."); break;
      case ts.SyntaxKind.TypeAssertionExpression: add(n, "cast: write x as Type, not <Type>x."); break;
      case ts.SyntaxKind.TypeParameter: add(n, "generics: declaring type parameters (<T>) is not allowed; write the concrete types."); break;
      case ts.SyntaxKind.AnyKeyword: case ts.SyntaxKind.UnknownKeyword: add(n, "type: any and unknown are not allowed; write the real type."); break;
      case ts.SyntaxKind.JsxSpreadAttribute: add(n, "jsx: spread props {...x} are not allowed; write the props out."); break;
      case ts.SyntaxKind.ExportAssignment: if ((n as ts.ExportAssignment).isExportEquals) add(n, "export: export = is not allowed; use export default."); else defaultExports++; break;
      case ts.SyntaxKind.ImportDeclaration: checkImport(n as ts.ImportDeclaration); break;
      case ts.SyntaxKind.ExportDeclaration: if ((n as ts.ExportDeclaration).moduleSpecifier) add(n, "export: re-exporting from a module is not allowed; export only your own scene."); break;
      default: break;
    }
    if (ts.canHaveModifiers(n)) {
      for (const m of ts.getModifiers(n) ?? []) {
        if (m.kind === ts.SyntaxKind.AsyncKeyword) add(m, "async: yield, await, async and generators are not allowed; a scene is plain synchronous code.");
        if (m.kind === ts.SyntaxKind.DeclareKeyword) add(m, "declare: declare is not allowed.");
        if (m.kind === ts.SyntaxKind.DefaultKeyword) defaultExports++;
      }
    }
    if ((ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n)) && n.asteriskToken) add(n, "async: yield, await, async and generators are not allowed; a scene is plain synchronous code.");
    if (ts.isCallExpression(n)) {
      if (n.expression.kind === ts.SyntaxKind.ImportKeyword) add(n, "import: dynamic import() is not allowed.");
      const callee = ts.isIdentifier(n.expression) ? n.expression.text : "";
      if (callee === "Array" || TYPED_ARRAYS.includes(callee)) sizeCheck(n, callee, n.arguments);
    }
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression)) {
      const callee = n.expression.text;
      if (callee === "Array" || TYPED_ARRAYS.includes(callee)) sizeCheck(n, callee, n.arguments ?? []);
    }
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      const t = n.text;
      if (t.length > MAX_STRING) add(n, `string: a text of ${t.length} characters is too long; the limit is ${MAX_STRING}.`);
      else if (URL_LIKE.test(t)) add(n, "string: a web address (http:, data:, //host ...) is not allowed in a scene; scenes cannot load anything.");
      else if (BANNED_STRINGS.has(t.toLowerCase())) add(n, `string: the text "${echo(t)}" is not allowed.`);
    }
    if (ts.isPropertyAccessExpression(n)) {
      const m = n.name.text.toLowerCase();
      const called = ts.isCallExpression(n.parent) && n.parent.expression === n;
      // texture.repeat is a three.js Vector2 (reading it is fine); "ab".repeat(8) is fine; "ab".repeat(1e9) is a memory bomb
      const smallRepeat = m === "repeat" && (!called || (n.parent as ts.CallExpression).arguments.length !== 1 || (evalNum((n.parent as ts.CallExpression).arguments[0]!) ?? Infinity) <= 1000);
      if (BANNED_MEMBERS.has(m) && !isCanvasCreate(n) && !smallRepeat) add(n, `member: .${echo(n.name.text)} is not allowed${BANNED_MEMBER_HINT[m] ? `; ${BANNED_MEMBER_HINT[m]}` : "; it can reach the page, the network or a prototype"}.`);
    }
    if (ts.isElementAccessExpression(n)) {
      const e = n.expression;
      const sym = ts.isIdentifier(e) ? refSymbol(e) : undefined;
      const info = sym ? importInfo(sym) : undefined;
      const isGlobal = ts.isIdentifier(e) && (!sym || (sym.declarations ?? []).length === 0 || (sym.declarations ?? []).every(isLibDecl));
      if (isGlobal || info?.ns) add(n, "computed key: a global or an imported module cannot be indexed with [..]; write Name.member so the check can see the member.");
      else checkKey(n.argumentExpression, n, n.expression);
    }
    if (ts.isComputedPropertyName(n)) checkKey(n.expression, n);
    // Destructuring reads members too: const { constructor } = x, ({ ownerDocument } = el), function f({ domElement }) {}
    const destructured = (key: ts.Node | undefined) => {
      if (!key || !(ts.isIdentifier(key) || ts.isStringLiteral(key))) return;
      const m = key.text.toLowerCase();
      if (BANNED_MEMBERS.has(m)) add(n, `member: destructuring .${echo(key.text)} is not allowed${BANNED_MEMBER_HINT[m] ? `; ${BANNED_MEMBER_HINT[m]}` : "; it can reach the page, the network or a prototype"}.`);
    };
    if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent)) destructured(n.propertyName ?? n.name);
    if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && isAssignmentPattern(n.parent)) destructured(n.name);
    if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n) || ts.isMethodDeclaration(n)) && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name))) {
      const k = n.name.text.toLowerCase();
      if (k === "__proto__" || k === "constructor" || k === "prototype") add(n, `member: the property name "${echo(n.name.text)}" is not allowed.`);
    }
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const tag = n.tagName;
      if (ts.isIdentifier(tag) && /^[a-z]/.test(tag.text)) {
        if (!R3F_TAGS.has(tag.text)) add(n, `jsx: <${echo(tag.text)}> is not allowed${TAG_HINT[tag.text.toLowerCase()] ? `; ${TAG_HINT[tag.text.toLowerCase()]}` : ""}. Only three.js elements (mesh, group, primitive, lights, geometries, materials) may be written as tags.`);
      } else if (!ts.isIdentifier(tag)) add(n, "jsx: only plain tag names are allowed (no a.b, no namespaces).");
    }
    if (ts.isJsxAttribute(n)) {
      const nm = ts.isIdentifier(n.name) ? n.name.text : "";
      if (!ts.isIdentifier(n.name)) add(n, "jsx: namespaced attributes are not allowed.");
      else if (BANNED_ATTRS.has(nm.toLowerCase())) add(n, `jsx: the attribute ${echo(nm)} is not allowed; scenes cannot load files or inject HTML.`);
    }
    if (ts.isIdentifier(n) && !isNameOnly(n)) {
      if (ALWAYS_OK.has(n.text)) { /* fine */ } else {
        const sym = refSymbol(n);
        const decls = sym?.declarations ?? [];
        if (!sym || decls.length === 0 || decls.every(isLibDecl)) globalUse(n);
        else {
          const info = importInfo(sym);
          const importedName = decls[0] && ts.isImportSpecifier(decls[0]) ? (decls[0].propertyName ?? decls[0].name).text : "";
          if (info && importedName === "useModels" && info.module === "s3k" && !isImportSpecifierName(n)) {
            const call = n.parent;
            if (!(ts.isCallExpression(call) && call.expression === n)) add(n, "useModels: call useModels(ids, resolver) directly; do not alias or pass it around.");
            else if (!isHostResolver(call.arguments[1])) add(n, "useModels: the second argument must be the resolver prop of the default-exported scene function (useModels(ids, resolver)); scenes cannot point the model loader at other addresses.");
          }
          if (info?.ns) {
            const p = n.parent;
            const ok = (ts.isPropertyAccessExpression(p) && p.expression === n && MODULE_NAMES[info.module]?.has(p.name.text)) || ts.isImportClause(p) || ts.isNamespaceImport(p);
            if (!ok && !ts.isImportClause(p) && !ts.isNamespaceImport(p)) {
              const member = ts.isPropertyAccessExpression(p) && p.expression === n ? p.name.text : "";
              add(n, member ? `import: ${info.module} "${echo(member)}" is not on the allow-list${/loader|cache/i.test(member) ? `; ${LOADER_NOTE}` : ""}.` : `import: "${n.text}" (the whole ${info.module} module) may only be used as ${n.text}.Name; do not alias, pass or destructure it.`);
            }
          }
          // function references feed the recursion check
          const declName = (ts.isFunctionDeclaration(n.parent) || ts.isVariableDeclaration(n.parent) || ts.isFunctionExpression(n.parent)) && n.parent.name === n;
          const fd = declName ? undefined : decls.find((d) => ts.isFunctionDeclaration(d) || (ts.isVariableDeclaration(d) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) || ts.isFunctionExpression(d));
          const from = fnStack[fnStack.length - 1];
          if (fd && from) {
            const target = ts.isVariableDeclaration(fd) ? fd.initializer! : fd;
            (edges.get(from) ?? edges.set(from, new Set()).get(from)!).add(target);
          }
        }
      }
    }
  };
  const sizeCheck = (n: ts.Node, name: string, args: readonly ts.Expression[]) => {
    const a = args[0];
    if (!a) return;
    const v = evalNum(a);
    const lim = name === "Array" ? MAX_ARRAY : MAX_TYPED;
    if (v === undefined && (localArray(a) || ts.isSpreadElement(a))) return; // an array given as the argument: already bounded
    if (v === undefined || !(v <= lim)) add(n, `size: ${name}(n) needs a constant n of at most ${lim} (a number, or a const made of numbers).`);
  };

  const walk = (n: ts.Node, depth: number) => {
    if (problems.length >= MAX_PROBLEMS * 3) return;
    if (++nodes > SCENE_MAX_NODES) return;
    if (depth > SCENE_MAX_DEPTH) { add(n, `nesting: the code is nested more than ${SCENE_MAX_DEPTH} levels deep; split it into small functions.`); return; }
    if (ts.isTypeNode(n) && !ts.isExpressionWithTypeArguments(n)) { if (n.kind === ts.SyntaxKind.AnyKeyword || n.kind === ts.SyntaxKind.UnknownKeyword) enter(n); else ts.forEachChild(n, (c) => { if (ts.isTypeNode(c)) walk(c, depth + 1); }); return; }
    enter(n);
    const isFn = ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);
    if (isFn) { fnStack.push(n); }
    let loop = 0;
    if (ts.isForStatement(n)) { loop = checkFor(n); loopDepth++; loopProduct *= loop; if (loopDepth > MAX_LOOP_NEST) add(n, `loop: loops are nested ${loopDepth} deep; at most ${MAX_LOOP_NEST}.`); if (loopProduct > 4_000_000) add(n, "loop: the nested loops run too many times in total; make the counts smaller."); }
    if (ts.isForOfStatement(n)) { loopDepth++; if (loopDepth > MAX_LOOP_NEST) add(n, `loop: loops are nested ${loopDepth} deep; at most ${MAX_LOOP_NEST}.`); }
    const iter = ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ITERATORS.has(n.expression.name.text);
    if (iter) { cbDepth++; if (cbDepth > MAX_LOOP_NEST + 1) add(n, "loop: array callbacks (map, forEach ...) are nested too deep; use plain for loops."); }
    ts.forEachChild(n, (c) => walk(c, depth + 1));
    if (iter) cbDepth--;
    if (ts.isForStatement(n)) { loopDepth--; loopProduct /= loop || 1; }
    if (ts.isForOfStatement(n)) loopDepth--;
    if (isFn) fnStack.pop();
  };
  walk(sf, 0);
  if (nodes > SCENE_MAX_NODES) problems.push(`size: the file has more than ${SCENE_MAX_NODES} code elements; write a shorter, simpler scene.`);
  if (defaultExports !== 1) problems.push("export: the file needs exactly one default export, the scene component: export default function Scene(props: SceneProps) { ... }.");
  // recursion: a function that (through any chain) refers to itself
  const state = new Map<ts.Node, 1 | 2>();
  const cyc = (f: ts.Node): boolean => {
    state.set(f, 1);
    for (const g of edges.get(f) ?? []) {
      if (state.get(g) === 1) return true;
      if (!state.has(g) && cyc(g)) return true;
    }
    state.set(f, 2);
    return false;
  };
  for (const f of edges.keys()) if (!state.has(f) && cyc(f)) { problems.push(`line ${sf.getLineAndCharacterOfPosition(f.getStart(sf)).line + 1}: recursion: a function that calls itself (directly or through other functions) is not allowed; use a loop.`); break; }
  return problems.length === 0 ? { ok: true, problems } : fail(problems);
}

/** The catalogue model ids a checked scene names: every string literal that the catalogue knows. Never throws. */
export function sceneModelIds(source: string, isId: (id: string) => boolean): string[] {
  const out = new Set<string>();
  try {
    const sf = ts.createSourceFile(FILE, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (n: ts.Node) => {
      if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text.length <= 80 && isId(n.text)) out.add(n.text);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  } catch {
    /* none */
  }
  return [...out].sort().slice(0, 60);
}
