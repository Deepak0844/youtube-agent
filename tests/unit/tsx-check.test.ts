import { describe, expect, it } from "vitest";
import { checkTsx, echo, TSX_MAX_BYTES } from "@/server/core/tsx-check";

const META = "export const meta = { durationInFrames: 90, fps: 30, width: 1080, height: 1920 };";
const GOOD = `import React from "react";
import { AbsoluteFill, Easing, Img, interpolate, random, staticFile, useCurrentFrame, Sequence } from "remotion";
import { Circle } from "@remotion/shapes";
import type { CSSProperties } from "react";

// A title that fades in.
const box: CSSProperties = { position: "absolute", top: 10, filter: "url(#blur)" };

const Dot = ({ i }: { i: number }) => {
  const frame = useCurrentFrame();
  const x = random("dot-" + i) * 1080;
  return <Circle radius={10} fill="red" style={{ transform: \`translateX(\${x + frame}px)\` }} />;
};

export default function Scene() {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 30], [0, 1], { easing: Easing.bezier(0.4, 0, 0.2, 1), extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const dots = [];
  for (let i = 0; i < 20; i++) dots.push(<Dot key={i} i={i} />);
  const items = ["process", "window", "Date"];
  return (
    <AbsoluteFill style={{ backgroundColor: "#111", opacity, backgroundImage: \`url(\${staticFile("bg.png")})\` }}>
      <Sequence from={10}><Img src={staticFile("assets/a.png")} style={box} /></Sequence>
      <Img src={staticFile("frames/1.png")} />
      <svg width={100} height={100}><use href="#shape" /><rect stroke-width={2} /></svg>
      {items.map((t) => <p key={t}>{t} fetch it // later</p>)}
      <React.Fragment>{dots}</React.Fragment>
    </AbsoluteFill>
  );
}
${META}
`;

/** GOOD with one extra line in the component module scope. */
const withLine = (line: string) => GOOD.replace("// A title that fades in.", () => line);
const bad = (src: string) => {
  const r = checkTsx(src);
  expect(r.ok, `expected a problem for:\n${src.slice(0, 300)}`).toBe(false);
  return r.problems.join("\n");
};
const badLine = (line: string, re?: RegExp) => {
  const p = bad(withLine(line));
  if (re) expect(p).toMatch(re);
  return p;
};

describe("checkTsx: a well-formed scene passes", () => {
  it("accepts the reference scene", () => {
    expect(checkTsx(GOOD)).toEqual({ ok: true, problems: [] });
  });

  it("accepts export default arrow, meta as const, type-only imports and interfaces", () => {
    const src = `import { AbsoluteFill } from "remotion";\nimport type { FC } from "react";\ninterface P { n: Date }\nconst S: FC = () => <AbsoluteFill />;\nexport default S;\nexport const meta = { durationInFrames: 2700, fps: 30, width: 1080, height: 1920 } as const;\n`;
    expect(checkTsx(src)).toEqual({ ok: true, problems: [] });
  });
});

describe("checkTsx: input handling never throws", () => {
  it("rejects non-text, empty and oversize input before parsing", () => {
    for (const v of [undefined, null, 42, {}, [], Buffer.from("x"), Symbol("s")]) expect(checkTsx(v).ok).toBe(false);
    expect(checkTsx("   \n").problems[0]).toMatch(/empty/);
    expect(checkTsx("a".repeat(TSX_MAX_BYTES + 1)).problems).toEqual(["The file is bigger than 24 KB."]);
    expect(checkTsx("é".repeat(TSX_MAX_BYTES / 2 + 1)).problems[0]).toMatch(/bigger/); // bytes, not characters
    expect(checkTsx("x".repeat(50 * 1024 * 1024)).ok).toBe(false);
  });

  it("garbage, binary and pathological input give problems, not exceptions", () => {
    const inputs = [
      "}}}{{{<<<>>>",
      String.fromCharCode(...Array.from({ length: 4000 }, (_, i) => (i * 7919) % 256)),
      "(".repeat(20000),
      "[".repeat(20000),
      "<a>".repeat(5000),
      "`${".repeat(5000),
      "a+".repeat(10000) + "a",
      "\"" + "+\"".repeat(10000),
      "/*".repeat(10000),
      "\ud800abc",
      "export default 1;\n" + "x = 1 + ".repeat(2500) + "1;",
      "f(".repeat(8000) + ")".repeat(8000),
    ];
    for (const s of inputs) {
      const r = checkTsx(s);
      expect(r.ok).toBe(false);
      expect(r.problems.length).toBeGreaterThan(0);
      expect(r.problems.length).toBeLessThanOrEqual(20);
    }
  });

  it("deep nesting is refused, not a stack overflow", () => {
    const deep = `export default () => ${"[".repeat(3000)}1${"]".repeat(3000)};\n${META}`;
    expect(checkTsx(deep).problems.join()).toMatch(/nested too deeply|could not be checked/);
  });

  it("runs under 100 ms on a 24 KB worst case", () => {
    const body = Array.from({ length: 400 }, (_, i) => `const v${i} = interpolate(useCurrentFrame(), [0, ${i + 1}], ["a" + "b", \`c\${i}\`]);`).join("\n");
    const worst = (GOOD + body).slice(0, TSX_MAX_BYTES);
    const flood = ("window.fetch(eval('x'));\n").repeat(Math.floor(TSX_MAX_BYTES / 26));
    checkTsx(GOOD); // warm the TypeScript module
    for (const s of [worst, flood, "(".repeat(TSX_MAX_BYTES), "\"" + "url(".repeat(TSX_MAX_BYTES / 4 - 1)]) {
      const t = performance.now();
      checkTsx(s);
      expect(performance.now() - t).toBeLessThan(100);
    }
  });

  it("problems are capped and echoed text is short printable ASCII", () => {
    const r = checkTsx(("fetch(1);\n").repeat(500));
    expect(r.problems.length).toBeLessThanOrEqual(20);
    expect(echo("a".repeat(100))).toHaveLength(30);
    expect(echo("x‮y\u0000")).toBe("x?y?");
    const p = bad(`import x from "${"z".repeat(200)}";\n${GOOD}`);
    for (const line of p.split("\n")) expect(line).not.toMatch(/z{31}/);
  });
});

describe("checkTsx: imports", () => {
  it.each([
    [`import fs from "fs";`, /'fs' is not allowed/],
    [`import { readFileSync } from "node:fs";`, /not allowed/],
    [`import "remotion";`, /side-effect/],
    [`import * as R from "remotion";`, /import \* as/],
    [`import Remotion from "remotion";`, /default import/],
    [`import { delayRender } from "remotion";`, /delayRender/],
    [`import { getInputProps } from "remotion";`, /getInputProps/],
    [`import { useEffect } from "react";`, /useEffect/],
    [`import { useState } from "react";`, /useState/],
    [`import { interpolate as i2 } from "remotion";`, /renaming/],
    [`import { x } from "./other";`, /not allowed/],
    [`import { x } from "../kit/theme";`, /not allowed/],
    [`import { x } from "https://evil.example/x.js";`, /not allowed/],
    [`import data from "./a.json" with { type: "json" };`, /not allowed/],
    [`import cp = require("child_process");`, /require/],
    [`import { Circle } from "@remotion/shapes/dist/esm";`, /not allowed/],
    [`import { constructor } from "remotion";`, /not allowed/],
    [`import { hasOwnProperty } from "remotion";`, /not allowed/],
  ])("%s", (line, re) => {
    expect(bad(`${line}\n${GOOD}`)).toMatch(re);
  });

  it("React.* only allows the allow-listed members", () => {
    badLine("const s = React.useState(0);", /React\.useState/);
    badLine("const e = React.useEffect;", /React\.useEffect/);
    badLine("const c = React.createElement('script');", /createElement/);
    badLine("const k = React['useEffect'];", /computed lookup|not allowed/);
  });

  it("re-exports and extra exports are refused", () => {
    expect(bad(`export * from "fs";\n${GOOD}`)).toMatch(/re-exporting/);
    expect(bad(`export { default as X } from "remotion";\n${GOOD}`)).toMatch(/re-exporting/);
    expect(bad(`const a = 1; export { a };\n${GOOD}`)).toMatch(/export \{/);
    expect(bad(`export const other = 1;\n${GOOD}`)).toMatch(/only 'export default'/);
    expect(bad(`export function helper() {}\n${GOOD}`)).toMatch(/only 'export default'/);
  });
});

describe("checkTsx: forbidden globals and APIs", () => {
  it.each([
    "eval('1')", "(0, eval)('1')", "new Function('return 1')()", "Function('x')", "fetch('http://x')", "new XMLHttpRequest()",
    "new WebSocket('ws://x')", "new EventSource('/x')", "navigator.sendBeacon('/x')", "window.foo", "document.body",
    "globalThis.x", "self.x", "top.x", "parent.x", "process.env", "Buffer.from('x')", "require('fs')", "module.exports",
    "exports.x = 1", "new Worker('x')", "new SharedWorker('x')", "ServiceWorker", "localStorage.x", "sessionStorage.x",
    "indexedDB.open('x')", "setTimeout(() => 1, 1)", "setInterval(() => 1, 1)", "requestAnimationFrame(() => 1)",
    "queueMicrotask(() => 1)", "Date.now()", "new Date()", "performance.now()", "crypto.getRandomValues(a)",
    "Reflect.get(a, 'b')", "new Proxy({}, {})", "WebAssembly.instantiate(b)", "atob('x')", "importScripts('x')",
    "location.href", "new Image()", "caches.open('x')", "new RTCPeerConnection()", "customElements.define('a-b', C)",
    "postMessage(1)", "arguments", "__webpack_require__(1)", "globalThis['fetch']",
  ])("refuses %s", (expr) => {
    badLine(`const z = () => ${expr};`, /not allowed/);
  });

  it("explains timers, clock and network", () => {
    expect(badLine("setTimeout(() => 1, 5);")).toMatch(/useCurrentFrame/);
    expect(badLine("const d = Date.now();")).toMatch(/time comes from useCurrentFrame/);
    expect(badLine("fetch('/x');")).toMatch(/no network/);
  });

  it("refuses non-determinism: Math.random in every spelling, unseeded random()", () => {
    badLine("const r = Math.random();", /Math\.random/);
    badLine("const r = Math.random;", /Math\.random/);
    badLine("const r = Math['random']();", /random/);
    badLine("const r = Math['ran' + 'dom']();", /random/);
    badLine("const r = Math[`ran${'dom'}`]();", /random/);
    badLine("const { random: r } = Math;", /destructuring/);
    badLine("const f = () => random(null);", /fixed seed/);
    badLine("const f = () => random();", /fixed seed/);
    badLine("const f = () => random(undefined);", /fixed seed/);
  });

  it("refuses dynamic import, import.meta and require in any form", () => {
    badLine("const m = import('fs');", /dynamic import/);
    badLine("const u = import.meta.url;", /import\.meta/);
    badLine("const r = require;", /require/);
  });

  it("refuses prototype walking to reach Function", () => {
    badLine("const F = (() => 1).constructor;", /constructor/);
    badLine("const F = [].constructor.constructor('x');", /constructor/);
    badLine("const F = ({})['constructor'];", /constructor/);
    badLine("const F = ({})['const' + 'ructor'];", /constructor/);
    badLine("const F = ({})[`con${'structor'}`];", /constructor/);
    badLine("const F = ({})[('con') + ('struc' + 'tor')];", /constructor/);
    badLine("const F = ({}).__proto__;", /__proto__/);
    badLine("const P = Object.getPrototypeOf(async () => 1);", /getPrototypeOf|async/);
    badLine("const { constructor: C } = () => 1;", /constructor/);
    badLine("const o = { ['__pro' + 'to__']: 1 };", /__proto__/);
    badLine("const s = String.fromCharCode(101, 118, 97, 108);", /fromCharCode/);
    badLine("const k = 'construc' + 'tor';", /constructor/);
    badLine("const o = {}; const k = 'x'; const v = o['a' + k];", /built from text/);
  });

  it("refuses computed lookups on globals and imports", () => {
    badLine("const k = 'abs'; const f = Math[k];", /computed lookup on 'Math'/);
    badLine("const k = 'keys'; const f = Object[k];", /computed lookup on 'Object'/);
    badLine("const k = 'linear'; const e = Easing[k];", /computed lookup on 'Easing'/);
  });

  it("refuses unicode escapes, confusables, bidi and zero-width characters", () => {
    badLine("const a = \\u0065val;", /plain ASCII/);
    badLine("const a = \\u{65}val('1');", /plain ASCII/);
    badLine("const а = 1;", /plain ASCII/); // Cyrillic a
    badLine("const a = 1; /* ‮ */", /U\+202E/);
    badLine("const a​ = 1;", /U\+200B/);
    badLine("const a = '⁦x⁩';", /U\+2066/);
    badLine("const a = '\u{E0041}';", /U\+E0041/); // Unicode tag smuggling
    badLine("const a = 1;\u0000", /U\+0000/);
    badLine("const a = 1;﻿", /U\+FEFF/);
  });

  it("refuses compiler, bundler and lint directives in comments", () => {
    badLine("// @ts-ignore\nconst a: number = 'x';", /@ts-/);
    badLine("/* @ts-nocheck */", /@ts-/);
    badLine("/** @jsx h */", /@jsx/);
    badLine("/** @jsxImportSource evil */", /@jsx/);
    badLine("/// <reference path=\"/etc/passwd\" />", /<reference/);
    badLine("//# sourceMappingURL=http://x/a.map", /sourcemappingurl/);
    badLine("/* webpackIgnore: true */", /webpack/);
    badLine("// eslint-disable-next-line", /eslint-disable/);
  });

  it("refuses tagged templates, with, namespaces, async and await", () => {
    badLine("const s = String.raw`x`;", /tagged template/);
    badLine("const s = tag`x`;", /tagged template/);
    badLine("namespace N { export const a = 1; }", /namespaces/);
    badLine("declare global { interface Window { x: 1 } }", /namespaces/);
    badLine("const f = async () => 1;", /async/);
    badLine("await 1;", /await/);
    badLine("const w = new (class {})();", /new/);
  });
});

describe("checkTsx: loops must be bounded", () => {
  it.each([
    "while (true) {}",
    "while (1) { break; }",
    "do {} while (false);",
    "for (;;) {}",
    "for (let i = 0; ; i++) {}",
    "for (let i = 0; i < n; i++) {}",
    "for (let i = 0; i < 1e9; i++) {}",
    "for (let i = 0; i < 100000; i++) {}",
    "for (let i = 0; i < 10; i--) {}",
    "for (let i = 0; i < 10; i += 0) {}",
    "for (let i = 0; i > -1; i++) {}",
    "for (let i = 0; i < 10; i++) { i--; }",
    "for (let i = 0; i < 10; i++) { i = 0; }",
    "for (let i = 0; i < 10; i++) { [i] = [0]; }",
    "for (let i = 0, j = 0; i < 10; i++) {}",
    "for (let i = k; i < 10; i++) {}",
    "for (const k in obj) {}",
  ])("refuses %s", (loop) => {
    badLine(loop, /loop|for\.\.\.in/);
  });

  it("allows bounded for and for...of", () => {
    expect(checkTsx(withLine("for (let i = 0; i <= 10000; i += 2) {}\nfor (const x of [1, 2]) {}")).ok).toBe(true);
  });
});

describe("checkTsx: JSX", () => {
  const jsx = (el: string) => withLine(`const X = () => (${el});`);
  it.each([
    ["<script>alert(1)</script>", /<script>/],
    ["<iframe src={staticFile('a.html')} />", /<iframe>/],
    ["<object data='x' />", /<object>/],
    ["<embed src='x' />", /<embed>/],
    ["<link rel='stylesheet' href='x' />", /<link>/],
    ["<style>{'body{}'}</style>", /<style>/],
    ["<meta httpEquiv='refresh' />", /<meta>/],
    ["<base href='http://x' />", /<base>/],
    ["<img src={staticFile('a.png')} />", /use <Img/],
    ["<video src={staticFile('a.mp4')} />", /<video>/],
    ["<svg><foreignObject /></svg>", /<foreignObject>/],
    ["<svg><animate attributeName='x' /></svg>", /<animate>/],
    ["<svg><set attributeName='href' to='javascript:1' /></svg>", /<set>/],
    ["<a href='https://x'>x</a>", /<a>/],
    ["<x-widget />", /custom element/],
    ["<svg:script />", /namespaced|not allowed/],
    ["<div dangerouslySetInnerHTML={{ __html: '<b/>' }} />", /dangerouslySetInnerHTML/],
    ["<div {...props} />", /spreading props/],
    ["<Img {...{ src: 'http://x' }} />", /spreading props/],
    ["<div ref={r} />", /ref is not allowed/],
    ["<div onClick={() => 1} />", /event handler/],
    ["<Img src={staticFile('a.png')} onError={() => 1} />", /event handler/],
    ["<Img src='https://evil.example/x.png' />", /must be staticFile/],
    ["<Img src={u} />", /must be staticFile/],
    ["<Img src={staticFile('../../etc/passwd')} />", /staticFile\(\) needs/],
    ["<Img src={staticFile('/etc/passwd')} />", /staticFile\(\) needs/],
    ["<Img src={staticFile('http://x/a.png')} />", /staticFile\(\) needs/],
    ["<Img src={staticFile(u)} />", /staticFile\(\) needs/],
    ["<Img src={staticFile(`${u}`)} />", /staticFile\(\) needs/],
    ["<svg><use href='https://x/s.svg#a' /></svg>", /must be staticFile/],
    ["<svg><use xlinkHref='data:x' /></svg>", /must be staticFile/],
    ["<svg><image xlink:href='http://x' /></svg>", /must be staticFile/],
    ["<div style={{ backgroundImage: 'url(http://x/a.png)' }} />", /url\(/],
    ["<div style={{ backgroundImage: 'URL( \"//x\")' }} />", /url\(/],
    ["<div style={{ backgroundImage: `url(${u})` }} />", /url\(/],
    ["<div style={{ backgroundImage: 'ur' + 'l(x)' }} />", /url\(/],
    ["<div style={{ backgroundImage: '\\\\75rl(x)' }} />", /backslash/],
    ["<div style={{ backgroundImage: 'image-set(\"x\" 1x)' }} />", /image-set/],
    ["<div style={{ animation: 'spin 1s infinite' }} />", /animations/],
    ["<div style={{ transition: 'all 1s' }} />", /transitions/],
    ["<T />", /must be a component declared/],
    ["<obj.tag />", /not allowed/],
    ["<this.x />", /not allowed/],
  ])("refuses %s", (el, re) => {
    expect(bad(jsx(el))).toMatch(re);
  });

  it("a string-valued 'component' cannot smuggle an intrinsic tag", () => {
    badLine("let T = () => null; T = 'script' as never; const X = () => <T />;", /must be a component/);
    badLine("const T = 'iframe'; const X = () => <T />;", /must be a component/);
    badLine("function W({ As }: { As: never }) { return <As />; }", /must be a component/);
  });
});

describe("checkTsx: exports and meta", () => {
  it("requires a default export and a valid meta", () => {
    expect(bad(GOOD.replace("export default function", "function"))).toMatch(/export default/);
    expect(bad(GOOD.replace(META, ""))).toMatch(/export const meta/);
    expect(bad(GOOD.replace("durationInFrames: 90", "durationInFrames: 2701"))).toMatch(/1 to 2700/);
    expect(bad(GOOD.replace("durationInFrames: 90", "durationInFrames: 0"))).toMatch(/1 to 2700/);
    expect(bad(GOOD.replace("durationInFrames: 90", "durationInFrames: 1.5"))).toMatch(/whole number/);
    expect(bad(GOOD.replace("durationInFrames: 90", "durationInFrames: -5"))).toMatch(/plain number/);
    expect(bad(GOOD.replace("durationInFrames: 90", "durationInFrames: n"))).toMatch(/plain number/);
    expect(bad(GOOD.replace("fps: 30", "fps: 60"))).toMatch(/fps must be 30/);
    expect(bad(GOOD.replace("width: 1080", "width: 1920"))).toMatch(/width must be 1080/);
    expect(bad(GOOD.replace("height: 1920", "height: 1080"))).toMatch(/height must be 1920/);
    expect(bad(GOOD.replace("height: 1920 }", "height: 1920, extra: 1 }"))).toMatch(/exactly/);
    expect(bad(GOOD.replace("height: 1920 }", "height: 1920, ...x }"))).toMatch(/plain number/);
    expect(bad(GOOD.replace("export const meta", "export let meta"))).toMatch(/export const meta/);
    expect(bad(GOOD.replace(META, "export const meta = makeMeta();"))).toMatch(/plain object/);
    expect(bad(`${GOOD}\nexport default () => null;`)).toMatch(/only one default/);
    expect(bad(`${GOOD}\nexport = 1;`)).toMatch(/export =|syntax/);
  });

  it("reports a syntax error with its line", () => {
    expect(bad("export default () => <div>;\n")).toMatch(/line \d+: syntax error/);
  });
});

describe("checkTsx: hardening (review findings)", () => {
  const ok = (line: string) => {
    const r = checkTsx(withLine(line));
    expect(r.problems, line).toEqual([]);
  };

  it("computed keys must be numbers", () => {
    badLine('const F = (() => 0)[["constr", "uctor"].join("")];', /computed keys must be numbers/);
    badLine("const k = 'x'; const o = {}; const v = o[k.slice(0)];", /computed keys must be numbers/);
    badLine("const o = {}; const v = o[`a${1}`];", /text keys|not allowed/);
    badLine("const o = { a: 1 }; const v = o['a'];", /text keys/);
    badLine("const s = 'x'; const o = {}; const v = o[s + 1];", /computed keys must be numbers/);
    badLine("const k = 1; const o = [1]; const v = o[k];", /computed keys must be numbers/);
    badLine("const o = [1]; const v = ['a'].map((x, i) => o[i]);", /computed keys must be numbers/);
    badLine("const k = 'x'; const o = { [k]: 1 };", /computed keys must be numbers/);
    badLine("const o = [1]; const v = o[String(1)];", /computed keys must be numbers/);
    // a name that is a loop counter in one place and text in another is not a counter
    badLine("for (let i = 0; i < 3; i++) {}\nconst f = () => { const i = 'x'; return ({} as never)[i]; };", /computed keys must be numbers/);
    ok("const o = [1, 2, 3]; const n = 2; const x = 1.5; const a = o[0]; const b = o[n % 3]; const c = o[n - 1]; const d = o[Math.floor(x)]; const e = o[n > 1 ? 0 : 1]; const g = o[-n * 2];");
    ok("const o = [1, 2, 3]; let t = 0; for (let i = 0; i < 3; i++) { t += o[i] + o[i + 1]; }");
    ok("const o = { [0]: 1 };");
  });

  it("refuses aliasing, shadowing or changing globals and imports", () => {
    badLine("const M = Math;", /may only be used as Math\.name/);
    badLine("const R = React;", /may only be used as React\.name/);
    badLine("const I = interpolate;", /may only be used as interpolate/);
    badLine("const F = Function;", /'Function' is not allowed/);
    badLine("const { floor } = Math;", /destructuring|may only be used/);
    badLine("const f = (m: unknown) => m; const x = f(Math);", /may only be used/);
    badLine("const a = [Object];", /may only be used/);
    badLine("const o = { Math };", /may only be used/);
    badLine("const m = (Math as never);", /may only be used/);
    badLine("Math.floor = () => 1;", /changing 'Math\.floor'/);
    badLine("const Math = { floor: () => 1 };", /may not be declared again/);
    badLine("const f = (interpolate: number) => interpolate;", /may not be declared again/);
    badLine("function g(undefined: number) { return undefined; }", /may not be declared again/);
    for (const e of ["globalThis", "window", "self", "Reflect", "Proxy", "Symbol.iterator", "Intl.NumberFormat", "this", "x.self", "new RegExp('a')"]) {
      badLine(`const z = (x: never) => ${e};`, /not allowed/);
    }
    badLine("const self = 1;", /'self' is not allowed/);
    badLine("const A = class {};", /classes/);
    badLine("class A {}", /classes/);
    badLine("function* g() { yield 1; }", /generators/);
    badLine("const o = { *g() { yield 1; } };", /generators/);
    badLine("const o = { get x() { return 1; } };", /getters and setters/);
    badLine("const o = { set x(v: number) {} };", /getters and setters/);
    ok("const a = [0, 1].filter(Boolean).map(String); const m = new Map(); const s = new Set([1]); const t = a instanceof Array;");
  });

  it("loops, arrays and strings stay bounded; no regex, no recursion", () => {
    badLine("const a = [1]; for (const x of a) {}", /for\.\.\.of only over an array literal/);
    badLine("const a = [1]; for (const x of [...a]) {}", /for\.\.\.of only over an array literal/);
    badLine("for (let i = 0; i < 2; i++) { for (let j = 0; j < 2; j++) { for (let k = 0; k < 2; k++) {} } }", /nested at most 2 deep/);
    badLine("for (let i = 0; i < 2; i++) { const f = () => { for (const a of [1]) { for (const b of [2]) {} } }; }", /nested at most 2 deep/);
    badLine("for (let i = 0; i < 1000; i++) { for (let j = 0; j < 1000; j++) {} }", /at most 100000 times/);
    badLine("const r = /a+/;", /regular expressions/);
    badLine("const r = new RegExp('a');", /RegExp/);
    badLine("const s = 'a'.repeat(1e9);", /'repeat' is not allowed/);
    badLine("const a = Array.from({ length: 5 });", /Array\.from/);
    badLine("const n = 5; const a = new Array(n);", /new Array\(n\) needs a number/);
    badLine("const a = Array(100000);", /Array\(n\) needs a number/);
    badLine("const a: number[] = []; a.length = 1e9;", /changing \.length/);
    badLine("const a: number[] = []; [a.length] = [1e9];", /changing \.length/);
    badLine("const a: number[] = []; a.fill(0);", /\.fill\(\) is only allowed/);
    badLine("const a = new Uint8Array(1e9);", /only new Map, new Set, new Array/);
    badLine("function f(n: number): number { return n < 1 ? 0 : f(n - 1); }", /recursion/);
    badLine("const f = (n: number): number => n < 1 ? 0 : f(n - 1);", /recursion/);
    badLine("const a = (n: number): number => b(n); const b = (n: number): number => a(n);", /recursion/);
    badLine("const X = (): React.ReactNode => <X />;", /recursion/);
    ok("const a = Array(10).fill(0); const b = new Array(5).fill(1); const c = [0, 0].fill(2); for (let i = 0; i < 100; i++) { for (const x of [1, 2]) {} }");
  });

  it("forbidden member names match case-insensitively; no element forgery", () => {
    badLine("const f = (x: never) => x.srcDoc;", /srcDoc/);
    badLine("const f = (x: never) => x.InnerHTML;", /InnerHTML/);
    badLine("const f = (x: never) => x.CONSTRUCTOR;", /CONSTRUCTOR/);
    badLine("const s = 'Constructor';", /not allowed as a value/);
    badLine("const o = { $$typeof: 1 };", /\$\$typeof/);
    badLine("const o = { '$$typeof': 1 };", /\$\$typeof/);
    badLine("const e = React.createElement('div');", /createElement/);
    badLine("const e = React.cloneElement(<div />);", /cloneElement/);
    badLine("const X = () => <div srcDoc='x' />;", /srcDoc/);
  });

  it("staticFile takes one plain literal name only", () => {
    for (const arg of ["`a/${n}.png`", "n", "'./a.png'", "'a/../b.png'", "'/a.png'", "'a b.png'", "'a.png', 'b'", "''"]) {
      badLine(`const n = 'a'; const s = staticFile(${arg});`, /staticFile\(\) needs one plain relative file name/);
    }
    ok("const s = staticFile('assets/a-1_b.png');");
  });

  it("ordinary local names are fine; the globals stay refused", () => {
    ok("const now = 1; const raw = 2; const open = 3; const top = 4; const f = (parent: number, frames: number) => now + raw + open + top + parent + frames;");
    badLine("const t = top;", /'top' is not allowed/);
    badLine("const f = () => { const top = 1; return top; }; const t = top;", /'top' is not allowed/);
    badLine("const f = (x: never) => x.now;", /'now' is not allowed/);
    badLine("const { now } = performance;", /now|performance/);
  });

  it("long + chains are fine up to 1000 parts", () => {
    ok(`const s = ${Array.from({ length: 1000 }, (_, i) => `"p${i}"`).join(" + ")};`);
    badLine(`const s = ${Array.from({ length: 1001 }, () => "1").join(" + ")};`, /at most 1000 parts/);
  });
});
