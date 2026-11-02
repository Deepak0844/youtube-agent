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
      <Img src={staticFile(\`frames/\${frame % 10}.png\`)} />
      <svg width={100} height={100}><use href="#shape" /><rect stroke-width={2} /></svg>
      {items.map((t) => <p key={t}>{t} fetch it // later</p>)}
      <React.Fragment>{dots}</React.Fragment>
    </AbsoluteFill>
  );
}
${META}
`;

/** GOOD with one extra line in the component module scope. */
const withLine = (line: string) => GOOD.replace("// A title that fades in.", line);
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
