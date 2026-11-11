import { describe, expect, it } from "vitest";
import { checkTsx, echo, TSX_MAX_BYTES } from "@/server/core/tsx-check";
import { YT_KIT_NAMES } from "@/server/core/tsx-kit";

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
  // retry feedback for the model: "rule: problem; alternative", at most 120 characters after the line prefix
  for (const p of r.problems) {
    const msg = p.replace(/^line [\d?]+: /, "");
    expect(msg, p).toMatch(/^[a-z]+( error)?: .+; .+/);
    expect(msg.length, p).toBeLessThanOrEqual(120);
  }
  return r.problems.join("\n");
};
const okSrc = (src: string) => expect(checkTsx(src).problems).toEqual([]);
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

// Realistic model-written animations (review probe fp.ts): these must pass as written.
const META150 = "\nexport const meta = { durationInFrames: 150, fps: 30, width: 1080, height: 1920 };\n";
const ANIM_A = `import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig, Easing, Sequence } from "remotion";

const COLORS = ["#ff6b6b", "#feca57", "#48dbfb", "#1dd1a1"];
type BarProps = { label: string; value: number; index: number };

const Bar: React.FC<BarProps> = ({ label, value, index }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const grow = spring({ frame: frame - index * 6, fps, config: { damping: 14, stiffness: 120 } });
  const width = interpolate(grow, [0, 1], [0, value * 8]);
  return (
    <div style={{ display: "flex", alignItems: "center", marginBottom: 24 }}>
      <span style={{ width: 200, color: "white", fontSize: 40, fontFamily: "Inter, sans-serif" }}>{label}</span>
      <div style={{ height: 60, width, backgroundColor: COLORS[index % COLORS.length], borderRadius: 12 }} />
      <span style={{ marginLeft: 16, color: "#ddd", fontSize: 36 }}>{Math.round(value * grow)}%</span>
    </div>
  );
};

export default function Scene() {
  const frame = useCurrentFrame();
  const { width, height, durationInFrames } = useVideoConfig();
  const titleY = interpolate(frame, [0, 20], [-100, 0], { extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const fadeOut = interpolate(frame, [durationInFrames - 15, durationInFrames], [1, 0], { extrapolateLeft: "clamp" });
  const data = [
    { label: "Python", value: 72 },
    { label: "JS", value: 64 },
    { label: "Rust", value: 31 },
    { label: "Go", value: 25 },
  ];
  const sorted = [...data].sort((a, b) => b.value - a.value);
  const total = data.reduce((sum, d) => sum + d.value, 0);
  return (
    <AbsoluteFill style={{ background: "linear-gradient(180deg, #0f2027, #203a43)", opacity: fadeOut, padding: 80 }}>
      <h1 style={{ color: "white", fontSize: 80, transform: \`translateY(\${titleY}px)\`, textAlign: "center" }}>Top languages</h1>
      <Sequence from={15}>
        <div style={{ marginTop: height * 0.1, width: width - 160 }}>
          {sorted.map((d, i) => (
            <Bar key={d.label} label={d.label} value={d.value} index={i} />
          ))}
        </div>
      </Sequence>
      <p style={{ color: "#aaa", fontSize: 30 }}>Total: {total.toFixed(0)}</p>
    </AbsoluteFill>
  );
}
`;
const ANIM_B = `import { AbsoluteFill, interpolate, interpolateColors, useCurrentFrame, random } from "remotion";

const N = 40;
const particles = new Array(N).fill(0).map((_, i) => ({
  x: random(\`x-\${i}\`) * 1080,
  y: random(\`y-\${i}\`) * 1920,
  r: 4 + random(\`r-\${i}\`) * 10,
  speed: 0.5 + random(\`s-\${i}\`) * 2,
}));

export default function Scene() {
  const frame = useCurrentFrame();
  const t = frame / 30;
  const bg = interpolateColors(frame, [0, 75, 150], ["#1a1a2e", "#16213e", "#0f3460"]);
  const pulse = 1 + 0.05 * Math.sin(t * Math.PI * 2);
  const angle = (frame * 2) % 360;
  const cx = 540 + Math.cos(t) * 200;
  const cy = 960 + Math.sin(t) * 200;
  const textOpacity = interpolate(frame, [10, 40], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const words = "Physics is beautiful".split(" ");
  return (
    <AbsoluteFill style={{ backgroundColor: bg }}>
      <svg width={1080} height={1920} viewBox="0 0 1080 1920">
        <defs>
          <radialGradient id="glow">
            <stop offset="0%" stopColor="#e94560" stopOpacity={0.8} />
            <stop offset="100%" stopColor="#e94560" stopOpacity={0} />
          </radialGradient>
        </defs>
        <circle cx={cx} cy={cy} r={150 * pulse} fill="url(#glow)" />
        {particles.map((p, i) => {
          const y = (p.y - frame * p.speed * 4 + 1920) % 1920;
          return <circle key={i} cx={p.x} cy={y} r={p.r} fill="white" opacity={0.3 + 0.7 * Math.abs(Math.sin(t + i))} />;
        })}
        <g transform={\`rotate(\${angle} 540 960)\`}>
          <rect x={490} y={910} width={100} height={100} fill="none" stroke="#fff" strokeWidth={4} />
        </g>
      </svg>
      <div style={{ position: "absolute", bottom: 300, width: "100%", textAlign: "center", opacity: textOpacity }}>
        {words.map((w, i) => {
          const d = Math.max(0, Math.min(1, (frame - 20 - i * 8) / 15));
          return (
            <span key={w} style={{ display: "inline-block", margin: "0 12px", fontSize: 72, color: "white", transform: \`scale(\${d}) translateY(\${(1 - d) * 40}px)\` }}>
              {w}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
}
`;
const ANIM_C = `import { useMemo } from "react";
import { AbsoluteFill, Img, staticFile, interpolate, spring, useCurrentFrame, useVideoConfig, Series } from "remotion";
import { evolvePath } from "@remotion/paths";

interface Step { title: string; detail: string }
const STEPS: Step[] = [
  { title: "Water evaporates", detail: "Sun heats the ocean" },
  { title: "Clouds form", detail: "Vapor cools and condenses" },
  { title: "Rain falls", detail: "Drops get heavy" },
];
const PATH = "M 100 1500 C 300 1200, 700 1200, 980 1500";

const Card = ({ step, n }: { step: Step; n: number }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame, fps, durationInFrames: 20 });
  const opacity = interpolate(frame, [0, 10, 40, 50], [0, 1, 1, 0], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", opacity }}>
      <div style={{ transform: \`scale(\${s})\`, background: "rgba(255,255,255,0.1)", borderRadius: 32, padding: 60, width: 860 }}>
        <div style={{ fontSize: 48, color: "#9ad" }}>Step {n + 1}</div>
        <div style={{ fontSize: 84, fontWeight: 700, color: "white" }}>{step.title}</div>
        <div style={{ fontSize: 44, color: "#ccc", marginTop: 20 }}>{step.detail}</div>
      </div>
    </AbsoluteFill>
  );
};

export default function Scene() {
  const frame = useCurrentFrame();
  const progress = interpolate(frame, [0, 150], [0, 1], { extrapolateRight: "clamp" });
  const { strokeDasharray, strokeDashoffset } = evolvePath(progress, PATH);
  const drops = useMemo(() => Array.from({ length: 12 }, (_, i) => i * 90), []);
  const label = frame < 75 ? "Part 1" : "Part 2";
  const hue = Math.floor(200 + 40 * Math.sin(frame / 20));
  return (
    <AbsoluteFill style={{ backgroundColor: \`hsl(\${hue}, 60%, 15%)\` }}>
      <Img src={staticFile("assets/cloud.png")} style={{ position: "absolute", top: 100, left: 340, width: 400 }} />
      <svg width={1080} height={1920} style={{ position: "absolute" }}>
        <path d={PATH} stroke="#4fc3f7" strokeWidth={10} fill="none" strokeDasharray={strokeDasharray} strokeDashoffset={strokeDashoffset} />
        {drops.map((x) => <circle key={x} cx={x + 60} cy={(frame * 12 + x) % 1920} r={6} fill="#81d4fa" />)}
      </svg>
      <Series>
        {STEPS.map((step, i) => (
          <Series.Sequence key={step.title} durationInFrames={50}>
            <Card step={step} n={i} />
          </Series.Sequence>
        ))}
      </Series>
      <div style={{ position: "absolute", top: 40, right: 40, color: "white", fontSize: 32 }}>{label}</div>
    </AbsoluteFill>
  );
}
`;

describe("checkTsx: realistic animations pass (no false positives)", () => {
  it.each([["A: bar chart", ANIM_A], ["B: particles", ANIM_B], ["C: steps and path", ANIM_C]])("%s", (_, src) => {
    okSrc(src + META150);
  });

  it("common helpers pass", () => {
    const line = (l: string) => `import { AbsoluteFill } from "remotion";\n${l}\nexport default function Scene() { return <AbsoluteFill />; }${META150}`;
    for (const l of [
      "const a = [1]; const b = [...a, 2];",
      "const base = { color: 'red' }; const s = { ...base, fontSize: 10 };",
      "const COLORS: Record<string, string> = { a: 'red' }; const c = COLORS['a'];",
      "const COLORS: Record<string, string> = { a: 'red' }; const k = 'a'; const c = COLORS[k];",
      "const arr = [1, 2, 3]; const i = 2; const v = arr[i];",
      "const f = (arr: number[], i: number) => arr[i]; const v = f([1, 2], 1);",
      "const a = Array.from({ length: 5 }, (_, i) => i);",
      "const n = 5; for (let i = 0; i < n; i++) {}",
      "const a = [1, 2]; for (let i = 0; i < a.length; i++) {}",
      "const a = [1, 2]; for (const x of a) {}",
      "const st = { transition: 'none' };",
      "const g = [[1]].map((r) => [r].map((c) => [c].map((z) => z)));",
      "const ok = Number.isFinite(3); const s = (3.14159).toFixed(2); const pts = [{ x: 1, y: 2 }]; const out = pts.map(({ x, y }) => x + y);",
    ]) okSrc(line(l));
  });
});

describe("checkTsx: input handling never throws", () => {
  it("rejects non-text, empty and oversize input before parsing", () => {
    for (const v of [undefined, null, 42, {}, [], Buffer.from("x"), Symbol("s")]) expect(checkTsx(v).ok).toBe(false);
    expect(checkTsx("   \n").problems[0]).toMatch(/empty/);
    expect(checkTsx("a".repeat(TSX_MAX_BYTES + 1)).problems).toEqual(["size: the file is bigger than 24 KB; write a shorter scene."]);
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
  }, 30_000); // many large parses in one test: slow only when the whole suite runs at once

  it("deep nesting is refused, not a stack overflow", () => {
    const deep = `export default () => ${"[".repeat(3000)}1${"]".repeat(3000)};\n${META}`;
    expect(checkTsx(deep).problems.join()).toMatch(/nested too deeply|could not be checked/);
  });

  it("runs under 300 ms on a 24 KB worst case", () => {
    const body = Array.from({ length: 400 }, (_, i) => `const v${i} = interpolate(useCurrentFrame(), [0, ${i + 1}], ["a" + "b", \`c\${i}\`]);`).join("\n");
    const worst = (GOOD + body).slice(0, TSX_MAX_BYTES);
    const flood = ("window.fetch(eval('x'));\n").repeat(Math.floor(TSX_MAX_BYTES / 26));
    // name tracing: number params checked at every call site, frozen arrays, const chains, index callbacks
    const traced = (GOOD + Array.from({ length: 300 }, (_, i) => `const a${i} = [1, 2]; const p${i} = (x: number[], k: number) => x[k] + a${i}[k % 2]; let t${i} = p${i}(a${i}, ${i}) + p${i}(a${i}, t${i > 0 ? i - 1 : 0}); for (const y of a${i}) { t${i} += y; }`).join("\n")).slice(0, TSX_MAX_BYTES);
    checkTsx(GOOD); // warm the TypeScript module
    for (const s of [worst, flood, traced, "(".repeat(TSX_MAX_BYTES), "\"" + "url(".repeat(TSX_MAX_BYTES / 4 - 1)]) {
      // best of 3: a blowup is slow every time; a cold JIT on a busy CI runner is not
      let best = Infinity;
      for (let i = 0; i < 3; i++) {
        const t = performance.now();
        checkTsx(s);
        best = Math.min(best, performance.now() - t);
      }
      expect(best).toBeLessThan(300); // a real blowup takes seconds; 100 ms flaked on loaded CI runners (113 ms seen)
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

  describe("yt-kit", () => {
    it("accepts every exported name, one by one and all together", () => {
      expect(YT_KIT_NAMES.length).toBeGreaterThan(30);
      for (const n of YT_KIT_NAMES) expect(checkTsx(`import { ${n} } from "yt-kit";\n${GOOD}`)).toEqual({ ok: true, problems: [] });
      expect(checkTsx(`import { ${YT_KIT_NAMES.join(", ")} } from "yt-kit";\n${GOOD}`)).toEqual({ ok: true, problems: [] });
    });
    it("accepts type-only imports", () => {
      expect(checkTsx(`import type { CaptionWord } from "yt-kit";\n${GOOD}`).ok).toBe(true);
    });
    it.each([
      [`import { Bulb, notAName } from "yt-kit";`, /'notAName' is not allowed from 'yt-kit'/],
      [`import { PALETTE as P } from "yt-kit";`, /renaming/],
      [`import * as K from "yt-kit";`, /import \* as/],
      [`import Kit from "yt-kit";`, /default import/],
      [`import "yt-kit";`, /side-effect/],
      [`import { Bulb } from "yt-kit/index";`, /not allowed/],
      [`import { Bulb } from "./yt-kit";`, /not allowed/],
      [`import { saneNumbers } from "yt-kit";`, /not allowed from 'yt-kit'/],
      [`import { safeColor } from "yt-kit";`, /not allowed from 'yt-kit'/],
      [`import { constructor } from "yt-kit";`, /not allowed/],
    ])("%s", (line, re) => {
      expect(bad(`${line}\n${GOOD}`)).toMatch(re);
    });
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
    badLine("const f = () => random(null);", /seed must be text or a number/);
    badLine("const f = () => random();", /seed must be text or a number/);
    badLine("const f = () => random(undefined);", /seed must be text or a number/);
  });

  it("random(seed) takes text or a number, never a variable that could hold null", () => {
    badLine("const seed: any = null; const f = () => random(seed);", /seed must be text or a number/);
    badLine("let seed: any; const f = () => random(seed);", /seed must be text or a number/);
    badLine("const f = (s: string) => random(s);", /seed must be text or a number/);
    badLine("const f = (o: { s: string }) => random(o.s);", /seed must be text or a number/);
    const r = checkTsx(withLine("const k = 'a'; const n = 3; const f = (i: number) => random(k) + random(n) + random(`x-${i}`) + random('y-' + i) + random(7);"));
    expect(r.problems).toEqual([]);
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
    badLine("const k = 'keys'; const f = Number[k];", /computed lookup on 'Number'/);
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
    badLine("const f = (o: any) => o['a'];", /text keys in \[\.\.\.\] work only on a const object literal/);
    badLine("const s = 'x'; const o = {}; const v = o[s + 1];", /computed keys must be numbers/);
    badLine("const k = 'x'; const o = { [k]: 1 };", /computed keys must be numbers/);
    badLine("const o = [1]; const v = o[String(1)];", /computed keys must be numbers/);
    // a name that is a loop counter in one place and text in another is not a counter
    badLine("for (let i = 0; i < 3; i++) {}\nconst f = () => { const i = 'x'; return ({} as never)[i]; };", /text keys/);
    ok("const o = [1, 2, 3]; const n = 2; const x = 1.5; const a = o[0]; const b = o[n % 3]; const c = o[n - 1]; const d = o[Math.floor(x)]; const e = o[n > 1 ? 0 : 1]; const g = o[-n * 2];");
    ok("const o = [1, 2, 3]; let t = 0; for (let i = 0; i < 3; i++) { t += o[i] + o[i + 1]; }");
    ok("const o = { [0]: 1 };");
  });

  it("indexes: numbers, array-callback indexes, number params and literal keys on const object literals", () => {
    ok("const k = 1; const o = [1]; const v = o[k];");
    ok("const o = [1]; const v = ['a'].map((x, i) => o[i]);");
    ok("const o = ['a']; const d = [{ n: 1 }]; const v = [...d].sort((a, b) => a.n - b.n).map((x, i) => o[i]);");
    ok("const o = ['a']; const v = 'a b'.split(' ').filter((w, i) => o[i]);");
    ok("const pick = (arr: string[], i: number) => arr[i]; const v = pick(['a'], 0) + pick(['b'], 1 + 1);");
    ok("const COLORS: Record<string, string> = { a: 'red', b: 'blue' }; const k = 'b'; const v = COLORS['a'] + COLORS[k];");
    ok("const frame = 3; const pal = ['#a', '#b']; const c = pal[frame > 2 ? 1 : 0] + pal[frame % 2];");
    // the index of a callback on something that is not provably an array may be text (a custom .map can pass anything)
    badLine("const g = (xs: any, o: any) => xs.map((x: number, i: number) => o[i]);", /computed keys must be numbers/);
    badLine("const o = [1]; const g = (xs: { map: Function }) => xs.map((x: never, i: never) => o[i]);", /computed keys must be numbers/);
    // a number param of a function that is called with text (through a cast) is not a number
    badLine("const pick = (arr: any, i: number) => arr[i]; const s = 'x'; const v = pick([], s as any);", /computed keys must be numbers/);
    badLine("const pick = (arr: any, i: number) => arr[i]; const v = [pick].map((f) => f);", /computed keys must be numbers/);
    // still refused: Object.prototype names, built keys, lookups on functions, imports and globals
    for (const k of ["'toString'", "'constructor'", "'__proto__'", "'valueOf'", "'hasOwnProperty'"]) badLine(`const R = { a: 1 }; const v = R[${k}];`, /not allowed/);
    badLine("const R = { a: 1 }; const p = 'a'; const v = R[p + 'b'];", /built from text/);
    badLine("const R = { a: 1 }; const v = R[['a'].join('')];", /built from text/);
    badLine("const R = { a: 1 }; const k = `${'a'}${R.a}`; const v = R[k];", /built from text|text keys/);
    badLine("function F() { return null; } const v = F[0];", /computed lookup on 'F'/);
    badLine("const F = () => null; const v = F[0];", /computed lookup on 'F'/);
    badLine("const v = interpolate[0];", /computed lookup on 'interpolate'/);
    badLine("const v = Math[0];", /computed lookup on 'Math'/);
  });

  it("refuses aliasing, shadowing or changing globals and imports", () => {
    badLine("const M = Math;", /may only be used as Math\.name/);
    badLine("const R = React;", /may only be used as React\.name/);
    badLine("const I = interpolate;", /may only be used as interpolate/);
    badLine("const F = Function;", /'Function' is not allowed/);
    badLine("const { floor } = Math;", /destructuring|may only be used/);
    badLine("const f = (m: unknown) => m; const x = f(Math);", /may only be used/);
    badLine("const a = [Number];", /may only be used/);
    badLine("const o = { Math };", /may only be used/);
    badLine("const m = (Math as never);", /may only be used/);
    badLine("Math.floor = () => 1;", /changing 'Math'/);
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
    ok("const a = [0, 1].filter(Boolean).map(String); const t = a instanceof Array;");
  });

  it("loops, arrays and strings stay bounded; no regex, no recursion", () => {
    badLine("const a = [1]; a.push(2); for (const x of a) {}", /for\.\.\.of only over an array literal/);
    badLine("const f = (a: number[]) => { for (const x of a) {} };", /for\.\.\.of only over an array literal/);
    badLine("const a = [1]; for (const x of [...a]) {}", /for\.\.\.of only over an array literal/);
    badLine("let x = 0; for (x of [1]) {}", /must declare its variable/);
    badLine("for (let i = 0; i < 2; i++) { for (let j = 0; j < 2; j++) { for (let k = 0; k < 2; k++) {} } }", /nested at most 2 deep/);
    badLine("for (let i = 0; i < 2; i++) { const f = () => { for (const a of [1]) { for (const b of [2]) {} } }; }", /nested at most 2 deep/);
    badLine("for (let i = 0; i < 1000; i++) { for (let j = 0; j < 1000; j++) {} }", /at most 100000 times/);
    badLine("const r = /a+/;", /regular expressions/);
    badLine("const r = new RegExp('a');", /RegExp/);
    badLine("const s = 'a'.repeat(1e9);", /'repeat' is not allowed/);
    badLine("const a = Array.from([1, 2]);", /Array\.from needs a literal size/);
    badLine("const a = Array.from({ length: 5000 });", /Array\.from needs a literal size/);
    badLine("const a = Array.from({ length: 5, x: 1 });", /Array\.from needs a literal size/);
    badLine("const n = 5000; const a = new Array(n);", /new Array\(n\) needs n/);
    badLine("let n = 5; const a = new Array(n);", /new Array\(n\) needs n/);
    badLine("const a = Array(100000);", /Array\(n\) needs n/);
    badLine("const a: number[] = []; a.length = 1e9;", /writing '\.length'/);
    badLine("const a: number[] = []; [a.length] = [1e9];", /destructuring assignment/);
    badLine("const a: number[] = []; a.push(1); a.fill(0);", /\.fill\(\) only on a literal-sized array/);
    badLine("const a = new Uint8Array(1e9);", /only new Array\(n\)/);
    badLine("const m = new Map();", /'new Map' is not allowed \(only new Array\(n\)\); use \[\] or \{\} instead of Map\/Set/);
    badLine("function f(n: number): number { return n < 1 ? 0 : f(n - 1); }", /recursion/);
    badLine("const f = (n: number): number => n < 1 ? 0 : f(n - 1);", /recursion/);
    badLine("const a = (n: number): number => b(n); const b = (n: number): number => a(n);", /recursion/);
    badLine("const X = (): React.ReactNode => <X />;", /recursion/);
    ok("const a = Array(10).fill(0); const b = new Array(5).fill(1); const c = [0, 0].fill(2); for (let i = 0; i < 100; i++) { for (const x of [1, 2]) {} }");
  });

  it("literal-sized arrays: Array(N) / Array.from({ length: N }) with a const N, arr.length bounds, for...of a const array", () => {
    ok("const N = 40; const a = new Array(N).fill(0).map((_, i) => i); const b = Array(N); const c = Array.from({ length: N }, (_, i) => i * 2);");
    ok("const n = 5; for (let i = 0; i < n; i++) {}");
    ok("const a = [1, 2]; for (let i = 0; i < a.length; i++) {} for (const x of a) {} const s = [...a].map((v) => v);");
    ok("const a = Array.from({ length: 12 }, (_, i) => i); for (let i = 0; i < a.length; i++) {}");
    // a.length of an array that can grow (push, an element write, passed away) is not a bound
    badLine("const a = [1]; for (let i = 0; i < a.length; i++) { a.push(i); }", /for loops need/);
    badLine("const a = [1]; a[5] = 1; for (let i = 0; i < a.length; i++) {}", /for loops need/);
    badLine("const a = [1]; const f = (x: number[]) => x; f(a); for (const x of a) {}", /for\.\.\.of only over/);
    badLine("const n = 100000; for (let i = 0; i < n; i++) {}", /for loops need/);
    badLine("const a = Array(1000).fill(0); for (let i = 0; i < a.length; i++) { for (let j = 0; j < a.length; j++) {} }", /at most 100000 times/);
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

  it("no React element forgery: object spread, JSON and Object helpers are refused", () => {
    const repro = `const el = <div />; const X = () => <AbsoluteFill>{{ ...el, type: "iframe", props: JSON.parse('{"srcDoc":"<script>..</script>"}') }}</AbsoluteFill>;`;
    const p = badLine(repro, /object spread/);
    expect(p).toMatch(/'JSON' is not allowed/);
    for (const e of ["JSON.parse('{}')", "Object.fromEntries([])", "Object.assign({}, {})", "Object.entries({})", "Object.values({})", "Object.create(null)", "Object.defineProperty({}, 'a', {})", "Object.setPrototypeOf({}, null)", "structuredClone({})"]) {
      badLine(`const z = () => ${e};`, /not allowed/);
    }
    // {...base} only for a const object literal of this file without element keys
    ok("const base = { color: 'red', fontSize: 10 }; const s = { ...base, fontSize: 12 }; const X = () => <div style={{ ...base, opacity: 1 }} />;");
    badLine("const a = { type: 'iframe' }; const c = { ...a };", /object spread/);
    badLine("const a = { props: {} }; const c = { ...a };", /object spread|'props'/);
    badLine("const f = (p: { a: number }) => ({ ...p });", /object spread/);
    badLine("const a = { b: 1 }; const c = { ...a }; const d = { ...c };", /object spread/);
    badLine("let a = { b: 1 }; const c = { ...a };", /object spread/);
  });

  it("no element mutation: element fields, props reads and prototype names are never written", () => {
    badLine(`const e: any = <Img src={staticFile("a.png")} />; e.props.src = "https://evil.example/x.png";`, /'props'/);
    badLine(`const e: any = <div />; e.type = "iframe";`, /writing '\.type'/);
    for (const k of ["type", "key", "ref", "children", "_owner", "constructor", "prototype", "map", "filter"]) {
      badLine(`const o: any = {}; o.${k} = 1;`, /not allowed/);
      badLine(`const o: any = {}; o.x.${k} = 1;`, /not allowed/);
    }
    badLine("const o: any = {}; o['type'] = 1;", /x\[\.\.\.\] = needs a number index/);
    badLine("const p = (e: any) => e.props;", /'props' is not allowed/);
    badLine("const o: any = {}; o.$$typeof = 1;", /not allowed/);
    badLine("const o: any = {}; o.a.__html = 1;", /'__'/);
    ok("const o = { x: 1, list: [0] }; o.x = 2; o.x += 1; o.list[0] = 3; const t = { type: 'bar' }; const k = t.type;");
  });

  it("names cannot be rebound: functions, components, imports, consts and casts", () => {
    badLine(`function X() { return null; }\nfunction go() { (X as any) = "style"; return <X>@import "https://evil.example/a.css";</X>; }`, /type casts on the left/);
    badLine(`function X() { return null; }\nfunction go() { (X as any) = "iframe"; return <X />; }`, /type casts on the left/);
    badLine("function X() { return null; } function go() { X = 'style' as never; }", /only number 'let's may change, not 'X'/);
    badLine("const T = () => null; const f = () => { (T as unknown as string) = 'style'; };", /type casts/);
    badLine("const c = 1; const f = () => { (c as any)++; };", /type casts/);
    badLine("const c = 1; const f = () => { c = 2; };", /only number 'let's/);
    badLine("var v = 1; v = 2;", /only number 'let's/);
    badLine("const f = (n: number) => { n = 2; return n; };", /only number 'let's/);
    badLine("let s = 'a'; s = 'b';", /only number 'let's may change, not 's'/);
    badLine("let t = 0; t = 'x' as never;", /must stay a number/);
    badLine("let t = 0; const o = { v: 1 }; t += o.v;", /must stay a number/);
    badLine("let t = 0; let u = 0; [t, u] = [u, t];", /destructuring assignment/);
    badLine("const f = () => { interpolate = (() => 1) as never; };", /type casts|only number|may only be used/);
    badLine("function X() { return null; } X.Y = 'style';", /changing 'X'/);
    badLine("const X = () => null; const f = () => { X.displayName = 'style'; };", /changing 'X'/);
    badLine("(Sequence as any).x.y = 'style';", /type casts/);
    badLine("const a = { x: 1 }; const b = { x: 2 }; const f = (c: boolean) => { (c ? a : b).x = 3; };", /only a named object's fields/);
    badLine("const f = () => { Sequence.x.y = 'style'; };", /changing 'Sequence'/);
    // a tag must resolve to a component, not just share its name
    badLine("function X() { return null; }\nfunction go() { const X = 'style'; return <X>x</X>; }", /must be a component declared/);
    badLine("function X() { return null; }\nvar X = 'style';\nconst Y = () => <X />;", /must be a component declared/);
    badLine("function C({ I }: { I: never }) { return <I />; }", /must be a component declared/);
    badLine("function X() { return null; } const Y = () => <X.Y />;", /member tags only on imports/);
    ok("let t = 0; let y = 1; for (let i = 0; i < 3; i++) { t += i * 2; y = y * 2 + Number('1'); t++; t -= 1; } const X = () => null; const Y = () => <X />;");
  });

  it("text cannot glue url(, @import or javascript: together at run time", () => {
    badLine(`const f = () => { const u = "ur"; return { backgroundImage: u + "l(https://evil.example/x.png)" }; };`, /url\(/);
    badLine(`const st = { backgroundImage: ["ur", "l(https://evil.example/x.png)"].join("") };`, /url\(/);
    badLine("const u = 'ur'; const st = { backgroundImage: `${u}l(https://e.example/x)` };", /url\(/);
    badLine(`const st = { backgroundImage: "ur".concat("l(x)") };`, /url\(/);
    badLine("const f = (p: string) => ({ backgroundImage: `${p}l(https://e.example/x)` });", /glued from pieces/);
    badLine("const f = (p: string) => ({ backgroundImage: 'u' + p });", /glued from pieces/);
    badLine("const f = (p: string) => ({ backgroundImage: [p, '(https://x)'].join('') });", /glued from pieces/);
    badLine("const f = (p: string) => '@imp' + p;", /glued from pieces/);
    badLine("const f = (p: string) => p + 'script:alert(1)';", /glued from pieces/);
    badLine("const s = '@import \"x.css\";';", /@import/);
    badLine("const X = () => <p>url(https://x)</p>;", /in text is not allowed/);
    badLine("const X = () => <p>@import x</p>;", /in text is not allowed/);
    badLine("const X = () => <p>javascript:alert(1)</p>;", /in text is not allowed/);
    badLine("const X = () => <p>width: expression(alert(1))</p>;", /in text is not allowed/);
    ok("const f = (label: string, n: number, w: string) => [`${label}: ${n}%`, `translateX(${n}px) scale(${n})`, `hsl(${n}, 60%, 15%)`, label + ' (' + w + ')', `url(#${'g'})`];");
    ok("const X = () => <p>JavaScript: the good parts</p>;");
  });

  it("no recursion through objects or arrays, no self-doubling growth", () => {
    badLine("const o = { f: (n: number): number => (n <= 0 ? 1 : o.f(n - 1) + o.f(n - 1)) };\nconst v = o.f(60);", /recursion/);
    badLine("const o = { f(n: number): number { return n <= 0 ? 1 : o.f(n - 1); } };", /recursion/);
    badLine("const a: ((n: number) => number)[] = [];\na.push((n) => (n <= 0 ? 1 : a[0]!(n - 1) + a[0]!(n - 1)));\nconst v = a[0]!(60);", /recursion/);
    badLine("const fs = [(n: number): number => fs[0]!(n)];", /recursion/);
    badLine("const go = () => { let a = [0]; for (let i = 0; i < 40; i++) { a = a.concat(a); } };", /only number 'let's/);
    badLine("const go = () => { let s = 'x'; for (let i = 0; i < 40; i++) { s = s + s; } };", /only number 'let's/);
    badLine("const go = () => { const o = { s: 'x' }; for (let i = 0; i < 40; i++) { o.s += o.s; } };", /built from itself/);
    badLine("const go = () => { const a = [0]; for (let i = 0; i < 40; i++) { a.push(...a); } };", /spread into itself/);
    ok("const o = { f: (n: number) => n * 2, g: 3 }; const v = o.f(2) + o.g; const a = [1, 2].map((x) => x).indexOf(1);");
  });

  it("no webpack free variables: declare, ambient blocks and __ names are refused", () => {
    badLine("declare const __webpack_public_path__: string;", /'declare' is not allowed|__/);
    badLine("declare let x: number;", /'declare' is not allowed/);
    badLine("declare function f(): void;", /'declare' is not allowed/);
    badLine("declare module 'x' {}", /declare|namespaces/);
    badLine("declare global { const q: number }", /declare|namespaces/);
    badLine("declare type T = number;", /'declare' is not allowed/);
    for (const e of ["__webpack_public_path__", "__webpack_chunk_load__('x')", "x.__proto__", "x.__foo", "({ __a: 1 })", "({ '__a': 1 })"]) {
      badLine(`const z = (x: never) => ${e};`, /'__'/);
    }
    badLine("const __x = 1;", /'__'/);
  });

  it("free names must be on the allow-list", () => {
    for (const e of ["AbortSignal.timeout(1)", "scheduler.postTask(f)", "navigation.navigate('/')", "addEventListener('x', f)", "Object.keys({})", "new Map()", "new Set()", "new WeakMap()", "new WeakRef({})", "Promise.resolve()", "console.log(1)", "Error('x')", "Date"]) {
      badLine(`const f = () => 1; const z = () => ${e};`, /not allowed/);
    }
    ok("const z = Math.floor(parseFloat('1.5')) + parseInt('2', 10) + Number('3') + (isNaN(1) || !isFinite(2) ? NaN : Infinity) + String(1).length + (undefined ?? 0) + (Array.isArray([]) && Boolean(1) ? 1 : 0);");
  });

  it("hangs and bombs: padStart/padEnd, flatMap, self-application, deep callbacks, big arrays", () => {
    badLine("const s = 'a'.padStart(1e9);", /'padStart' is not allowed; use n < 10/);
    badLine("const s = 'a'.padEnd(1e9);", /padEnd/);
    badLine("const s = 'a'.repeat(3);", /'repeat' is not allowed; use Array\(n\)\.fill/);
    badLine("const a = [1].flatMap((x) => [x, x]);", /'flatMap' is not allowed; write the nested arrays out/);
    badLine("const y = (f: never) => (f as (g: never) => void)(f);", /passed to itself/);
    badLine("const w = (f: (g: unknown) => void) => f(f);", /passed to itself/);
    badLine("const a = [[[[1]]]].map((x) => x.map((y) => y.map((z) => z.map((q) => q))));", /nested at most 2 deep/);
    badLine("const a = [[[1]]].forEach((x) => x.filter((y) => y.some((z) => [z].every((q) => q))));", /nested at most 2 deep/);
    badLine("const a = Array(1001);", /up to 1000/);
    badLine("const a = new Array(5000);", /up to 1000/);
    ok("const a = [[1]].map((x) => x.map((y) => y + 1)); const b = Array(1000).fill(0); const g = [[1]].map((r) => [r].map((c) => [c].map((z) => z)));");
  });

  it("CSS transition/animation 'none' is fine; other values are refused", () => {
    ok("const st = { transition: 'none', animation: 'none' };");
    badLine("const st = { transition: 'opacity 1s' };", /animations\/transitions/);
  });

  it("long + chains are fine up to 1000 parts", () => {
    ok(`const s = ${Array.from({ length: 1000 }, (_, i) => `"p${i}"`).join(" + ")};`);
    badLine(`const s = ${Array.from({ length: 1001 }, () => "1").join(" + ")};`, /at most 1000 parts/);
  });
});

describe("checkTsx: round 3 (mutated number arrays, overloads, nesting, entities, tag allow-list)", () => {
  it("a number array that is mutated or passed around is no longer trusted as numbers", () => {
    badLine('const a=[0,0]; a.fill(["con","structor"].join(String(""))); const F=({})[a[0]][a[0]]; F("return 1");', /computed keys must be numbers/);
    badLine("const a=[1]; a.fill(null); random(a[0]);", /seed must be text or a number/);
    for (const m of ["sort()", "reverse()", "splice(0, 1, 'x')", "copyWithin(0, 1)", "pop()", "push('x')"]) {
      badLine(`const a=[0,1]; a.${m}; const o = {}; const v = o[a[0]];`, /computed keys must be numbers/);
    }
    badLine("const a=[0,1]; const b = a; const o = {}; const v = o[a[0]];", /computed keys must be numbers/);
    okSrc(withLine("const a=[0,1]; const o = [5, 6]; const v = o[a[0]] + a.length;"));
  });

  it("join needs a literal separator", () => {
    badLine('const s = ["a", "b"].join(String(""));', /join\(\) needs a literal text separator/);
    badLine("const sep = (x: string) => x; const s = ['a', 'b'].join(sep('-'));", /join\(\) needs a literal/);
    okSrc(withLine("const s = ['a', 'b'].join(', ') + ['c'].join();"));
  });

  it("a ': number' parameter is not trusted for overloads, unused, component or default-export functions", () => {
    const call = 'f(["con","structor"].join(String("")));';
    badLine(`function f(n:any):any; function f(n:number):any{ return ({})[n][n]; } ${call}`, /computed keys must be numbers/);
    badLine("function f(n: number) { return ({})[n]; }", /computed keys must be numbers/);
    badLine("function Pick(n: number) { return ({})[n]; } const x = Pick(1);", /computed keys must be numbers/);
    const dflt = GOOD.replace("export default function Scene() {", "export default function Scene(n: number) { const o = {}; const v = o[n];");
    expect(bad(dflt)).toMatch(/computed keys must be numbers/);
    okSrc(withLine("function pick(n: number) { return [1, 2][n]; } const v = pick(1) + pick(0);"));
  });

  it("callbacks nest 2 deep, 3 only over small literal arrays; arrays built in callbacks stay bounded", () => {
    badLine("const f = (a: number[]) => a.map((x) => [x].map((y) => [y].map((z) => z)));", /nested at most 2 deep/);
    badLine("const a = [1, 2].flat();", /'flat' is not allowed/);
    badLine("const a = Array(1000).fill(0).map(() => Array(1000).fill(0));", /may total at most 100000/);
    badLine("const a = Array(1000).fill(0).map(() => Array.from({ length: 500 }));", /may total at most 100000/);
    okSrc(withLine("const a = Array(100).fill(0).map(() => Array(100).fill(0));"));
  });

  it("HTML entities in JSX attributes and text are refused", () => {
    expect(bad(GOOD.replace("<rect stroke-width={2} />", '<rect fill="&#117;rl(https://evil.test/a.svg#x)" />'))).toMatch(/entity/);
    expect(bad(GOOD.replace("<rect stroke-width={2} />", "<text>&#117;rl(x)</text>"))).toMatch(/entities/);
    expect(bad(GOOD.replace("<rect stroke-width={2} />", '<rect fill="a&amp;b" />'))).toMatch(/entity/);
  });

  it("lower-case JSX tags come from an allow-list", () => {
    for (const t of ["input", "textarea", "button", "form", "select", "video", "audio", "canvas", "base", "template", "slot", "dialog", "details", "summary", "table", "center"]) {
      expect(bad(GOOD.replace("<rect stroke-width={2} />", `<${t} />`)), t).toMatch(/is not allowed/);
    }
    for (const t of ["g", "path", "circle", "rect", "line", "polyline", "polygon", "ellipse", "text", "tspan", "defs", "linearGradient", "radialGradient", "stop", "clipPath", "mask", "div", "span", "p", "h1"]) {
      expect(checkTsx(GOOD.replace("<rect stroke-width={2} />", `<${t} />`)).problems, t).toEqual([]);
    }
  });
});
