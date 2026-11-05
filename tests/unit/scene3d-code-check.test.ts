import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkScene3dCode, S3K_ALLOWED, sceneModelIds, SCENE_MAX_BYTES, THREE_ALLOWED } from "@/server/core/scene3d-code-check";
import { S3K_API_DTS, S3K_API_MD, S3K_EXAMPLE_A, S3K_EXAMPLE_B } from "@/server/core/s3k-kit-dts";

const KIT = path.join(process.cwd(), "remotion", "kit", "s3k");
const read = (f: string) => readFileSync(path.join(KIT, f), "utf8");

/** A valid scene around `body`; the imports cover everything the cases use. */
const wrap = (body: string, imports = `import { World, Finish, CameraRig, rest } from "s3k";\nimport { Mesh, BoxGeometry, MeshStandardMaterial, Vector3 } from "three";\n`) =>
  `${imports}export default function Scene() {\n${body}\n  return <World focus={{ min: [0, 0, 0], max: [1, 1, 1] }} />;\n}\n`;
const problems = (src: string) => checkScene3dCode(src).problems.join("\n");
const rejects = (src: string, re: RegExp) => {
  const r = checkScene3dCode(src);
  expect(r.ok, `should be rejected:\n${src}`).toBe(false);
  expect(r.problems.join("\n")).toMatch(re);
};

describe("the embedded kit copy", () => {
  it("is identical to the kit files (run node scripts/sync-s3k-kit-dts.mjs)", () => {
    expect(S3K_API_DTS).toBe(read("api.d.ts"));
    expect(S3K_API_MD).toBe(read("API.md"));
    expect(S3K_EXAMPLE_A).toBe(read("authoring/harbour-crane.scene.tsx"));
    expect(S3K_EXAMPLE_B).toBe(read("authoring/rising-tower.scene.tsx"));
  });
  it("allows the kit names minus the host-owned page pieces, and no loader of three", () => {
    expect(S3K_ALLOWED).toContain("World");
    expect(S3K_ALLOWED).toContain("useModels");
    for (const n of ["Stage", "Captions", "TimeContext"]) expect(S3K_ALLOWED).not.toContain(n);
    expect(THREE_ALLOWED.filter((n) => /loader|cache|imageutils|clock|shadermaterial/i.test(n))).toEqual([]);
  });
});

describe("positive: real scenes pass unchanged", () => {
  it("passes the two authoring examples", () => {
    expect(checkScene3dCode(S3K_EXAMPLE_A)).toEqual({ ok: true, problems: [] });
    expect(checkScene3dCode(S3K_EXAMPLE_B)).toEqual({ ok: true, problems: [] });
  });
  /**
   * The kit's own example files import their siblings by relative path (the render bundles them with the kit); a scene is ONE file importing
   * "s3k". So relative kit imports are rewritten to "s3k", sibling imports are dropped, and the names they brought are the only findings
   * ignored. Every other construct of the real code is checked as written.
   */
  const findings = (src: string): string[] => {
    const dropped: string[] = [];
    const rewritten = src
      .replace(/^import(?! type)[^;]*from "\.\/(?!\.)[^"]*";\n/gm, (m) => { dropped.push(...(m.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])); return ""; })
      .replace(/^import(?! type)[^;]*from "\.\.\/meta";\n/gm, (m) => { dropped.push(...(m.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])); return ""; })
      .replace(/from "\.\.\/[A-Za-z]+"/g, 'from "s3k"')
      .replace(/^import type[^;]*from "\.\.?\/[^"]*";\n/gm, "");
    return checkScene3dCode(rewritten).problems.filter((p) => {
      if (/import: |export: the file needs exactly one default export|useModels: the second argument|computed key: an index/.test(p)) return false; // the kit's named scene components get their resolver from Demo.tsx
      const g = /global: "([A-Za-z0-9_]+)" is not available/.exec(p);
      return !(g && dropped.includes(g[1]!));
    });
  };
  it("passes the kit's own tunnel and reclamation example scenes (only names from sibling files are ignored)", () => {
    for (const f of ["TunnelScene.tsx", "ReclamationScene.tsx"]) expect(findings(read(`examples/${f}`)), f).toEqual([]);
  });
  it("passes the kit helper files of the examples (three.js geometry code); only loops with a non-constant bound and values from sibling files are refused", () => {
    for (const f of ["tbm", "train", "boats", "station", "street", "reclamation", "dims", "lining"]) {
      // a hand-written builder may loop up to a parameter (x <= x1); a model-written scene must use a constant bound, so those are refused by design
      const bad = findings(read(`examples/${f}.ts`)).filter((p) => !/loop: |computed key/.test(p));
      expect(bad, f).toEqual([]);
    }
    expect(findings(read("examples/lining.ts")).some((p) => /unbounded for loop/.test(p))).toBe(true);
  });
  it("accepts allowed constructs", () => {
    expect(checkScene3dCode(wrap("const m = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: '#fff' }));\n  const v = new Vector3(1, 2, 3).multiplyScalar(Math.sin(2));")).ok).toBe(true);
    expect(checkScene3dCode(wrap("const a = new Float32Array(300);\n  for (let i = 0; i < 300; i++) a[i] = i * 0.5;")).ok).toBe(true);
    expect(checkScene3dCode(wrap("const xs = [1, 2, 3].map((x) => x * 2).filter(Boolean);\n  const c = document.createElement('canvas');\n  c.width = 64;")).ok).toBe(true);
    expect(checkScene3dCode(wrap("const N = 10;\n  const s = new Set<number>();\n  for (let i = N; i > 0; i -= 2) s.add(i);")).ok).toBe(true);
  });
  it("finds the catalogue ids a scene names", () => {
    expect(sceneModelIds(S3K_EXAMPLE_A, (id) => id.startsWith("pp_"))).toEqual(["pp_crane_17ab", "pp_shipping_container_dqxr", "pp_sail_ship_cizo"].sort());
    expect(sceneModelIds("this is not code {{{", () => true)).toEqual(expect.any(Array));
  });
});

describe("imports (allow-list)", () => {
  const cases: [string, string, RegExp][] = [
    ["an unknown module", `import fs from "fs";`, /import: "fs" is not an allowed module/],
    ["a node: module", `import { readFileSync } from "node:fs";`, /not an allowed module/],
    ["a relative module", `import { x } from "./other";`, /not an allowed module/],
    ["a url module", `import x from "https://evil.example/x.js";`, /not an allowed module/],
    ["a bare side-effect import", `import "three";`, /bare import/],
    ["three TextureLoader", `import { TextureLoader } from "three";`, /loader or file reader/],
    ["three FileLoader", `import { FileLoader } from "three";`, /loader or file reader/],
    ["three ImageLoader", `import { ImageLoader } from "three";`, /loader or file reader/],
    ["three ImageBitmapLoader", `import { ImageBitmapLoader } from "three";`, /loader or file reader/],
    ["three Cache", `import { Cache } from "three";`, /loader or file reader/],
    ["three examples loaders", `import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";`, /not an allowed module/],
    ["three ShaderMaterial", `import { ShaderMaterial } from "three";`, /not on the allow-list/],
    ["three Clock", `import { Clock } from "three";`, /not on the allow-list/],
    ["an unlisted fiber name", `import { Canvas } from "@react-three/fiber";`, /not exported/],
    ["an unlisted remotion name", `import { Img } from "remotion";`, /not exported/],
    ["remotion delayRender", `import { delayRender } from "remotion";`, /not exported/],
    ["an unlisted kit name", `import { Stage } from "s3k";`, /not exported/],
    ["a made-up kit name", `import { hackTheWorld } from "s3k";`, /not exported/],
    ["an unlisted react name", `import { useEffect } from "react";`, /not exported/],
    ["a drei import", `import { useGLTF } from "@react-three/drei";`, /not an allowed module/],
  ];
  for (const [name, imp, re] of cases) it(`rejects ${name}`, () => rejects(`${imp}\nexport default function Scene() { return null; }\n`, re));
  it("rejects export-from, dynamic import, import equals and import.meta", () => {
    rejects(`export { Mesh } from "three";\nexport default function S() { return null; }`, /re-exporting/);
    rejects(wrap("const m = import('three');"), /dynamic import/);
    rejects(`import x = require("fs");\nexport default function S() { return null; }`, /import = require/);
    rejects(wrap("const u = import.meta.url;"), /meta/);
  });
  it("accepts type-only imports", () => {
    expect(checkScene3dCode(`import type { Group } from "three";\nimport type { SceneProps } from "s3k";\nexport default function S(p: SceneProps): Group | null { return null; }`).ok).toBe(true);
  });
  it("namespace imports of three: members are checked, aliasing and computed access are refused", () => {
    const head = `import * as T from "three";\n`;
    expect(checkScene3dCode(`${head}export default function S() { const m = new T.Mesh(new T.BoxGeometry(1, 1, 1)); return null; }`).ok).toBe(true);
    rejects(`${head}export default function S() { const l = new T.TextureLoader(); return null; }`, /not on the allow-list/);
    rejects(`${head}export default function S() { const k = T['Text' + 'ureLoader']; return null; }`, /imported module cannot be indexed/);
    rejects(`${head}export default function S() { const X = T; return null; }`, /whole three module/);
    rejects(`${head}export default function S() { const { TextureLoader } = T; return null; }`, /whole three module/);
    rejects(`${head}export default function S() { return Object.keys(T).length ? null : null; }`, /whole three module/);
    rejects(`${head}export default function S() { return T["Mesh"] ? null : null; }`, /imported module cannot be indexed/);
  });
});

describe("globals, network, storage, windows, timers", () => {
  const banned: [string, string, RegExp][] = [
    ["fetch", "fetch('/x');", /"fetch" is not available/],
    ["an aliased fetch", "const f = fetch; f('/x');", /"fetch" is not available/],
    ["a destructured fetch from the global", "const { fetch: f } = globalThis; f('/x');", /global object/],
    ["globalThis", "const g = globalThis;", /global object/],
    ["window", "const w = window;", /global object/],
    ["self", "const w = self;", /global object/],
    ["top and parent and frames", "const w = top; const p = parent; const f = frames;", /global object/],
    ["XMLHttpRequest", "const x = new XMLHttpRequest();", /"XMLHttpRequest"/],
    ["WebSocket", "const x = new WebSocket('ws://127.0.0.1:3000');", /"WebSocket"/],
    ["EventSource", "const x = new EventSource('/e');", /"EventSource"/],
    ["navigator", "navigator.sendBeacon('/x', 'y');", /"navigator"/],
    ["Worker", "new Worker('w.js');", /"Worker"/],
    ["SharedWorker", "new SharedWorker('w.js');", /"SharedWorker"/],
    ["importScripts", "importScripts('x.js');", /"importScripts"/],
    ["postMessage", "postMessage('x');", /"postMessage"/],
    ["BroadcastChannel", "new BroadcastChannel('c');", /"BroadcastChannel"/],
    ["indexedDB", "indexedDB.open('d');", /"indexedDB"/],
    ["localStorage", "localStorage.setItem('a', 'b');", /"localStorage"/],
    ["sessionStorage", "sessionStorage.getItem('a');", /"sessionStorage"/],
    ["document.cookie", "const c = document.cookie;", /"document"|member: .cookie/],
    ["document.body", "document.body.appendChild(null as never);", /"document"|member/],
    ["createElement of a script", "const s = document.createElement('script');", /"document"|createElement/],
    ["createElement with a computed tag", "const t = 'scr' + 'ipt'; document.createElement(t);", /"document"|createElement/],
    ["an aliased document", "const d = document; d.createElement('canvas');", /"document"/],
    ["location", "location.href = 'x';", /"location"/],
    ["history", "history.pushState(0, '', '/');", /"history"/],
    ["open", "open('http://x');", /"open"/],
    ["close", "close();", /"close"/],
    ["alert", "alert(1);", /"alert"/],
    ["Image", "const i = new Image();", /"Image"/],
    ["Audio", "new Audio('a.mp3');", /"Audio"/],
    ["eval", "eval('1');", /"eval" is not available/],
    ["an indirect eval", "(0, eval)('1');", /"eval"/],
    ["Function", "new Function('return 1')();", /"Function"/],
    ["Function through constructor", "(() => 1).constructor('return 1')();", /constructor/],
    ["setTimeout", "setTimeout(() => 1, 0);", /"setTimeout"/],
    ["setTimeout with a string", "setTimeout('alert(1)', 0);", /"setTimeout"/],
    ["setInterval", "setInterval(() => 1, 5);", /"setInterval"/],
    ["requestAnimationFrame", "requestAnimationFrame(() => 1);", /"requestAnimationFrame"/],
    ["queueMicrotask", "queueMicrotask(() => 1);", /"queueMicrotask"/],
    ["Date", "const t = Date.now();", /"Date"/],
    ["performance", "const t = performance.now();", /"performance"/],
    ["Math.random", "const r = Math.random();", /Math.random is not allowed/],
    ["Reflect", "Reflect.get(globalThis, 'fetch');", /"Reflect"|global object/],
    ["Proxy", "new Proxy({}, {});", /"Proxy"/],
    ["Symbol", "const s = Symbol('x');", /"Symbol"/],
    ["Promise", "Promise.resolve(1);", /"Promise"/],
    ["JSON", "JSON.parse('{}');", /"JSON"/],
    ["RegExp", "new RegExp('a');", /"RegExp"/],
    ["require", "const m = require('fs');", /"require"/],
    ["process", "const e = process.env;", /"process"/],
    ["WebAssembly", "WebAssembly.compile(new Uint8Array(1));", /"WebAssembly"/],
    ["URL", "new URL('http://x');", /"URL"/],
    ["Blob", "new Blob(['x']);", /"Blob"/],
    ["console", "console.log('x');", /"console"/],
  ];
  for (const [name, body, re] of banned) it(`rejects ${name}`, () => rejects(wrap(body), re));
  it("shadowing a global does not hide the real one (real scope analysis)", () => {
    rejects(wrap("function f(fetch: number) { return fetch; }\n  fetch('/x');"), /"fetch" is not available/);
    rejects(wrap("{ const fetch = 1; }\n  fetch('/x');"), /"fetch" is not available/);
    expect(checkScene3dCode(wrap("const fetch = (x: number) => x * 2;\n  const y = fetch(2);")).ok).toBe(true); // a local of your own is fine
  });
  it("refuses unicode-escaped names and aliases of allowed globals", () => {
    rejects(wrap("\\u0066etch('/x');"), /"fetch"/);
    rejects(wrap("const M = Math;"), /may only be used as Math.name/);
    rejects(wrap("const f = Array; f(3);"), /may only be used as Array/);
    rejects(wrap("Object.setPrototypeOf({}, null);"), /Object.setPrototypeOf is not allowed|setPrototypeOf/);
    rejects(wrap("Object.getPrototypeOf({});"), /Object.getPrototypeOf is not allowed|getPrototypeOf/);
    rejects(wrap("const k = Object.getOwnPropertyDescriptor({}, 'a');"), /not allowed/);
  });
});

describe("prototype pollution and dynamic lookups", () => {
  const cases: [string, string, RegExp][] = [
    ["a constructor chain by name", "const f = [][\"constructor\"][\"constructor\"];", /computed key|constructor/],
    ["a constructor chain by dot", "const f = [].constructor.constructor;", /member: .constructor/],
    ["this.constructor", "const o = { f() { return this.constructor; } };", /this|constructor/],
    ["__proto__ access", "const p = ({} as { __proto__: unknown }).__proto__;", /__proto__/],
    ["__proto__ in an object literal", "const o = { __proto__: { x: 1 } };", /__proto__/],
    ["a computed __proto__ key", "const o = { ['__proto__']: 1 };", /computed key/],
    ["prototype access", "const p = Array.prototype;", /prototype/],
    ["a built-up string key", "const k = 'constr' + 'uctor';\n  const f = [][k as unknown as number];", /type: any and unknown|computed key|constructor/],
    ["a string variable as a key", "const o = { a: 1 } as Record<string, number>;\n  const k = 'a';\n  const v = o[k];", /computed key/],
    ["a parameter as a key", "const get = (o: Record<string, number>, k: string) => o[k];", /computed key/],
    ["a template key", "const o = { a: 1 } as Record<string, number>;\n  const v = o[`a`];\n  const w = o[`c${1}`];", /computed key/],
    ["an any type", "const x: any = 1;", /any and unknown/],
    ["as unknown", "const x = 1 as unknown as string;", /any and unknown/],
    ["for in", "for (const k in { a: 1 }) { }", /for...in/],
    ["with in strict code is a syntax error or banned", "with ({}) { }", /syntax|with/],
    ["Math[x]", "const f = Math['floor'];", /cannot be indexed/],
    ["a getter", "const o = { get a() { return 1; } };", /accessor/],
    ["a class", "class A { }", /class/],
    ["a decorator on a class", "@dec class A { }", /class|decorator|syntax/],
    ["a tagged template", "const s = String`x`;", /tagged template/],
    ["a regex literal", "const r = /(a+)+$/.test('aaaa');", /regular expressions/],
    ["a label", "outer: for (let i = 0; i < 2; i++) { continue outer; }", /label/],
    ["async code", "const f = async () => 1;", /async/],
    ["a generator", "function* g() { yield 1; }", /generators/],
    ["await", "const f = async () => { await 1; };", /async|await/],
    ["enum", "enum E { A }", /enum/],
    ["namespace", "namespace N { export const a = 1; }", /namespace|enum/],
    ["declare", "declare const z: number;", /declare/],
    ["a type assertion with angle brackets", "const x = <number>(1 as number);", /syntax|cast|angle/],
    ["onBeforeCompile", "const m = new MeshStandardMaterial(); m.onBeforeCompile = () => undefined;", /onBeforeCompile/],
    ["setAttribute src", "const c = document.createElement('canvas'); c.setAttribute('src', 'http://x');", /setAttribute/],
    [".src =", "const c = { src: '' }; c.src = 'x';", /\.src/],
    ["domElement", "const e = useThree().gl.domElement;", /domElement|"useThree"/],
    ["ownerDocument", "const d = (1 as unknown as { ownerDocument: number }).ownerDocument;", /ownerDocument|any and unknown/],
    ["innerHTML", "const d = { innerHTML: '' }; d.innerHTML = '<img src=x>';", /innerHTML/],
    ["a web address", "const u = 'https://evil.example/x.png';", /web address/],
    ["a data url", "const u = 'data:image/png;base64,AAAA';", /web address/],
    ["a protocol relative url", "const u = '//evil.example/x';", /web address/],
    ["a loopback url", "const u = 'http://127.0.0.1:3000/api';", /web address/],
    ["a ws url", "const u = 'ws://localhost:3900';", /web address/],
    ["the string constructor", "const k = 'constructor';", /not allowed/],
    ["repeat", "const s = 'a'.repeat(1e9);", /repeat/],
    ["padStart", "const s = 'a'.padStart(1e9);", /padstart/i],
    ["fromCharCode", "const s = String.fromCharCode(65);", /String\.fromCharCode|String may/],
    ["String.raw", "const s = String.raw`x`;", /String\.raw|tagged|String may/],
  ];
  for (const [name, body, re] of cases) it(`rejects ${name}`, () => rejects(wrap(body), re));
  it("refuses forbidden members reached by destructuring", () => {
    rejects(wrap("const { constructor } = {};"), /destructuring \.constructor/);
    rejects(wrap("const { ownerDocument: d } = { ownerDocument: 1 } as { ownerDocument: number };"), /destructuring \.ownerDocument/);
    rejects(wrap("const f = ({ domElement }: { domElement: number }) => domElement;"), /destructuring \.domElement/);
    rejects(wrap("let c: unknown;\n  ({ constructor: c } = {});"), /destructuring \.constructor|any and unknown/);
    rejects(wrap("let s = 0;\n  ({ a: { src: s } } = { a: { src: 1 } });"), /destructuring \.src/);
    rejects(wrap("for (const { cookie } of [{ cookie: 1 }]) { }"), /destructuring \.cookie/);
    expect(checkScene3dCode(wrap("const { x, y } = { x: 1, y: 2 };\n  const [a, b] = [x, y];\n  const f = ({ z }: { z: number }) => z + a + b;")).ok).toBe(true);
  });
  it("refuses a cast used as a computed key", () => {
    rejects(wrap("const k = 'constructor';\n  const a = [1];\n  const v = a[k as number];"), /computed key: an index/);
    rejects(wrap("const a = [1];\n  const v = a[(Math.floor(1) as number)];"), /computed key: an index/);
  });
  it("refuses generics (a type-parameter cast could make a text key look like a number) and allows Error", () => {
    rejects(wrap("function cast<T>(x: string): T { return x as T; }\n  const a = [1];\n  const v = a[cast<number>('constructor')];"), /generics/);
    rejects(wrap("const id = <T,>(x: T) => x;"), /generics/);
    expect(checkScene3dCode(wrap("if (Math.PI < 0) throw new Error('never');")).ok).toBe(true);
    rejects(wrap("const e = new Error('x').constructor;"), /constructor/);
  });
  it("allows an index that is a number BY SYNTAX into a locally declared array", () => {
    expect(checkScene3dCode(wrap("const a = [1, 2, 3];\n  const i = Math.floor(1.5);\n  const v = a[i] + a[0] + a[a.length - 1];\n  let s = 0;\n  for (let k = 0; k < 3; k++) s += a[k] + a[k + 1] + a[Math.min(k, 2)];")).ok).toBe(true);
    expect(checkScene3dCode(wrap("const p = new Float32Array(30);\n  for (let k = 0; k < 10; k++) { p[k * 3] = 1; p[k * 3 + 1] = 2; }")).ok).toBe(true);
  });
  it("LAYER 1 ALONE refuses every text key that TypeScript could be made to call a number (no type-check is run in these tests)", () => {
    const bad: [string, string][] = [
      ["as number", "const k = 'constructor';\n  const a = [1];\n  const v = a[k as number];"],
      ["as unknown as number", "const k = 'constructor';\n  const a = [1];\n  const v = a[k as unknown as number];"],
      ["a generic cast", "function f<T>(x: string): T { return x as T; }\n  const a = [1];\n  const v = a[f<number>('constructor')];"],
      ["an any value", "const k: any = 'constructor';\n  const a = [1];\n  const v = a[k];"],
      ["a parameter typed number", "const g = (k: number) => [1][k];"],
      ["a for-of variable", "const a = [1];\n  for (const k of a) { const v = a[k]; }"],
      ["a function result", "const k = Number('constructor');\n  const a = [1];\n  const v = a[k];"],
      ["an overload declaration trick", "declare function h(x: string): number;\n  const a = [1];\n  const v = a[h('constructor')];"],
      ["a string const cast to a literal union", "const k = 'constructor' as 1 | 2;\n  const a = [1];\n  const v = a[k];"],
      ["a let that is reassigned", "let k = 0;\n  const a = [1];\n  k = ('x' + 'y') as unknown as number;\n  const v = a[k];"],
      ["a counter that the body changes", "const a = [1];\n  for (let k = 0; k < 3; k++) { k = ('c' + 'o') as unknown as number; const v = a[k]; }"],
      ["a number-typed object property", "const o = { n: 0 };\n  const a = [1];\n  const v = a[o.n];"],
      ["a text literal key", "const a = [1];\n  const v = a['length'];"],
      ["an object that is not a local array", "const o = { x: 1 };\n  for (let k = 0; k < 3; k++) { const v = o[k]; }"],
      ["a call result as the object", "const f = () => [1];\n  for (let k = 0; k < 1; k++) { const v = f()[k]; }"],
      ["an array function parameter", "const g = (a: number[]) => a[0];"],
      ["a template key", "const a = [1];\n  const v = a[`${1}`];"],
      ["a computed property name from text", "const k = 'constructor';\n  const o = { [k]: 1 };"],
    ];
    for (const [name, body] of bad) expect(checkScene3dCode(wrap(body)).ok, name).toBe(false);
  });
});

describe("the model loader may only use the host's resolver", () => {
  const head = `import { World, useModels } from "s3k";\nimport type { SceneProps } from "s3k";\n`;
  const scene = (body: string, sig = "{ resolver }: SceneProps") => `${head}export default function Scene(${sig}) {\n${body}\n  return <World focus={{ min: [0, 0, 0], max: [1, 1, 1] }} />;\n}\n`;
  it("accepts the resolver prop, destructured or as props.resolver", () => {
    expect(checkScene3dCode(scene("const m = useModels(['a'], resolver);")).ok).toBe(true);
    expect(checkScene3dCode(scene("const m = useModels(['a'], p.resolver);", "p: SceneProps")).ok).toBe(true);
    expect(checkScene3dCode(scene("const m = useModels(['a'], res);", "{ resolver: res }: SceneProps")).ok).toBe(true);
  });
  it("rejects idResolver, a home-made resolver and a resolver that is not the prop", () => {
    rejects(`import { idResolver } from "s3k";\nexport default function Scene() { return null; }\n`, /"idResolver" is not exported/);
    rejects(scene("const m = useModels(['a'], { resolve: () => ({ url: 'x' }) });"), /second argument must be the resolver prop/);
    rejects(scene("const r = { resolve: () => ({ url: 'ht' + 'tp://127.0.0.1:3000/x' }) };\n  const m = useModels(['a'], r);"), /second argument must be the resolver prop/);
    rejects(scene("const resolver2 = resolver;\n  const m = useModels(['a'], resolver2);"), /second argument must be the resolver prop/);
    rejects(scene("const m = useModels(['a']);"), /second argument must be the resolver prop/);
    rejects(scene("const resolver = { resolve: () => null };\n  const m = useModels(['a'], resolver);", "p: SceneProps"), /second argument must be the resolver prop/);
    rejects(scene("const u = useModels;"), /do not alias/);
    rejects(`${head}function Inner({ resolver }: SceneProps) { return useModels(['a'], resolver) ? null : null; }\nexport default function Scene(p: SceneProps) { return <Inner resolver={{ resolve: () => null }} />; }\n`, /second argument must be the resolver prop/);
    rejects(scene("const m = useModels(['a'], resolver);", "{ resolver = { resolve: () => null } }: SceneProps"), /second argument must be the resolver prop/);
  });
  it("rejects page-walking members", () => {
    rejects(wrap("const g = useThree().gl.getContext().canvas;", `import { World } from "s3k";\nimport { useThree } from "@react-three/fiber";\n`), /\.canvas/);
    rejects(wrap("const c = document.createElement('canvas');\n  const d = c.getContext('2d')!.canvas.parentNode;"), /\.canvas|parentNode/);
    rejects(wrap("const c = document.createElement('canvas');\n  const x = c.children;"), /\.children/);
  });
});

describe("JSX", () => {
  const jsx = (el: string) => `import { World } from "s3k";\nexport default function Scene() {\n  return (<>${el}</>);\n}\n`;
  const cases: [string, string, RegExp][] = [
    ["<img src>", `<img src="x.png" />`, /<img> is not allowed/],
    ["<script>", `<script>alert(1)</script>`, /<script> is not allowed|text:/],
    ["<iframe>", `<iframe src="http://x" />`, /<iframe> is not allowed/],
    ["<div>", `<div>hello</div>`, /<div> is not allowed/],
    ["<video>", `<video />`, /<video> is not allowed/],
    ["<textureLoader>", `<textureLoader />`, /<textureLoader> is not allowed/],
    ["<svg>", `<svg />`, /<svg> is not allowed/],
    ["dangerouslySetInnerHTML", `<mesh dangerouslySetInnerHTML={{ __html: 'x' }} />`, /dangerouslySetInnerHTML/],
    ["a src attribute", `<mesh src="x" />`, /attribute src is not allowed/],
    ["an href attribute", `<group href="x" />`, /attribute href/],
    ["spread props", `<mesh {...({ position: [0, 0, 0] })} />`, /spread props/],
    ["a namespaced attribute", `<mesh xlink:href="x" />`, /namespaced|syntax/],
    ["a member tag", `<World.Item />`, /plain tag names/],
    ["onBeforeCompile prop", `<meshStandardMaterial onBeforeCompile={() => 1} />`, /onBeforeCompile/],
  ];
  for (const [name, el, re] of cases) it(`rejects ${name}`, () => rejects(jsx(el), re));
  it("accepts three.js elements", () => {
    expect(checkScene3dCode(jsx(`<mesh position={[0, 1, 0]} castShadow><boxGeometry args={[1, 1, 1]} /><meshStandardMaterial color="#ccc" /></mesh><ambientLight intensity={0.4} />`)).ok).toBe(true);
  });
});

describe("loops, recursion and sizes", () => {
  const cases: [string, string, RegExp][] = [
    ["while(true)", "while (true) { }", /while and do loops/],
    ["do while", "do { } while (true);", /while and do loops/],
    ["for(;;)", "for (;;) { }", /loop:/],
    ["a for without a step", "for (let i = 0; i < 10;) { }", /loop:/],
    ["a for with a wrong step", "for (let i = 0; i < 10; i--) { }", /step must move/],
    ["a for with an unbounded limit", "const n = (Math.floor(5) as number);\n  for (let i = 0; i < n; i++) { }", /loop bound must be a constant/],
    ["a for with a huge bound", "for (let i = 0; i < 1e9; i++) { }", /about 1000000000 times|runs about/],
    ["a for that changes its counter", "for (let i = 0; i < 10; i++) { i -= 1; }", /must not change the counter/],
    ["a for that grows its own array", "const a = [1];\n  for (let i = 0; i < a.length; i++) { a.push(i); }", /grows the array/],
    ["loops nested too deep", "for (let a = 0; a < 5; a++) for (let b = 0; b < 5; b++) for (let c = 0; c < 5; c++) for (let d = 0; d < 5; d++) { }", /nested 4 deep/],
    ["nested loops with a huge product", "for (let a = 0; a < 5000; a++) for (let b = 0; b < 5000; b++) { }", /too many times/],
    ["a recursion", "function f(n: number): number { return n <= 0 ? 0 : f(n - 1); }\n  f(3);", /recursion/],
    ["a mutual recursion", "function a(n: number): number { return b(n); }\n  function b(n: number): number { return a(n); }\n  a(1);", /recursion/],
    ["an arrow recursion", "const f = (n: number): number => (n <= 0 ? 0 : f(n - 1));\n  f(2);", /recursion/],
    ["a huge Array", "const a = new Array(1e9);", /size: Array/],
    ["a huge typed array", "const a = new Float32Array(1e9);", /size: Float32Array/],
    ["an unbounded Array size", "const f = (n: number) => new Array(n);", /size: Array/],
  ];
  for (const [name, body, re] of cases) it(`rejects ${name}`, () => rejects(wrap(body), re));
});

describe("file-level limits and text tricks", () => {
  it("rejects non-text, empty and oversized input", () => {
    expect(checkScene3dCode(42).ok).toBe(false);
    expect(checkScene3dCode("  ").ok).toBe(false);
    expect(problems("x".repeat(SCENE_MAX_BYTES + 1))).toMatch(/bigger than 60 KB/);
  });
  it("rejects huge strings", () => rejects(wrap(`const s = "${"a".repeat(2500)}";`), /too long/));
  it("rejects deep nesting before parsing", () => rejects(wrap(`const x = ${"(".repeat(300)}1${")".repeat(300)};`), /nested \d+ deep/));
  it("rejects a very long operator chain without overflowing", () => {
    const r = checkScene3dCode(wrap(`const x = ${Array.from({ length: 6000 }, () => "1").join(" + ")};`));
    expect(r.ok).toBe(false);
  });
  it("rejects non-ASCII, bidi and zero-width characters", () => {
    rejects(wrap("const caf\u00e9 = 1;"), /not plain ASCII/);
    rejects(wrap("const a = 1; // \u202e evil"), /not plain ASCII/);
    rejects(wrap("const a\u200b = 1;"), /not plain ASCII/);
    rejects(wrap("const s = '\ud83d\ude00';"), /not plain ASCII/);
  });
  it("rejects </script anywhere and directive comments", () => {
    rejects(wrap("// </script><script>alert(1)</script>"), /<\/script/);
    rejects(wrap("const s = '</SCRIPT>';"), /<\/script/);
    rejects(wrap("// @ts-ignore\n  const a: number = 'x';"), /@ts-/);
    rejects(wrap("/// <reference path='x' />\n  const a = 1;"), /<reference/);
    rejects(wrap("const a = import(/* webpackIgnore: true */ 'x');"), /webpack/);
    rejects(wrap("// sourceMappingURL=http://x"), /sourcemappingurl/);
  });
  it("needs exactly one default export and valid syntax", () => {
    rejects(`import { World } from "s3k";\nexport const a = 1;`, /exactly one default export/);
    rejects(`export default function A() { return null; }\nexport default function B() { return null; }`, /syntax|exactly one default export/);
    rejects(`export default function A( { return null; }`, /syntax/);
  });
  it("gives plain sentences, line first, capped at 20, no echo of long attacker text", () => {
    const r = checkScene3dCode(wrap(Array.from({ length: 60 }, (_, i) => `fetch('/${"x".repeat(200)}${i}');`).join("\n")));
    expect(r.ok).toBe(false);
    expect(r.problems.length).toBeLessThanOrEqual(20);
    for (const p of r.problems) {
      expect(p).toMatch(/^line \d+: /);
      expect(p.length).toBeLessThanOrEqual(260);
      expect(p).not.toContain("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    }
  });
  it("never throws on garbage", () => {
    for (const s of ["\u0000", "<<<<", "export default", "import {", "}}}}", "`", "'", "/*", "<a><b></a>"]) expect(() => checkScene3dCode(s)).not.toThrow();
  });
});
