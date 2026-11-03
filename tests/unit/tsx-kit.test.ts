import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { kitDocs, kitExportNames, YT_KIT_NAMES } from "@/server/core/tsx-kit";
import { YT_KIT_DTS } from "@/server/core/tsx-kit-dts";
import { typeCheckInThread } from "@/server/providers/renderer/tsx-render";
import { fmt, num, PALETTE, polyAt, rotorAngle, safeColor, txt } from "../../remotion/kit/tsxlib/util";

const LIB = path.join(process.cwd(), "remotion", "kit", "tsxlib");

describe("yt-kit export list", () => {
  it("the embedded declaration text is the file (run node scripts/sync-tsx-kit-dts.mjs after editing yt-kit.d.ts)", () => {
    expect(YT_KIT_DTS).toBe(readFileSync(path.join(LIB, "yt-kit.d.ts"), "utf8"));
  });
  it("the barrel exports exactly the names of the declaration file (value exports)", () => {
    const sf = ts.createSourceFile("index.ts", readFileSync(path.join(LIB, "index.ts"), "utf8"), ts.ScriptTarget.ES2022, true);
    const barrel: string[] = [];
    for (const st of sf.statements) {
      if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) for (const e of st.exportClause.elements) barrel.push(e.name.text);
    }
    expect([...barrel].sort()).toEqual([...YT_KIT_NAMES].sort());
    expect(new Set(barrel).size).toBe(barrel.length);
  });
  it("every name is a defined value at run time (the library imports and builds)", async () => {
    const lib = (await import("../../remotion/kit/tsxlib/index")) as Record<string, unknown>;
    for (const n of YT_KIT_NAMES) expect(lib[n], n).toBeDefined();
    expect(Object.keys(lib).sort()).toEqual([...YT_KIT_NAMES].sort());
  });
});

describe("yt-kit type-check", () => {
  const scene = (body: string) => `import { Bulb, Canvas } from "yt-kit";\nexport default function Scene() { return ${body}; }\nexport const meta = { durationInFrames: 30, fps: 30, width: 1080, height: 1920 };\n`;
  it("types the import from the declaration file: right props pass, wrong or unknown ones fail", async () => {
    expect(await typeCheckInThread(scene("<Canvas><Bulb cx={540} cy={600} glow={0.5} /></Canvas>"), 60_000)).toEqual({ ok: true, problems: [] });
    const wrong = await typeCheckInThread(scene('<Canvas><Bulb cx="left" cy={600} /></Canvas>'), 60_000);
    expect(wrong.ok).toBe(false);
    const unknown = await typeCheckInThread(scene("<Canvas><Bulb cx={1} cy={2} onClick={1} /></Canvas>"), 60_000);
    expect(unknown.ok).toBe(false);
    const other = await typeCheckInThread(`import { x } from "yt-kit/index";\nexport default function Scene() { return null; }\n`, 60_000);
    expect(other.ok).toBe(false);
  }, 120_000);
});

describe("kitDocs", () => {
  it("documents every export on one line, from the declaration file", () => {
    const docs = kitDocs(YT_KIT_DTS);
    const lines = docs.split("\n");
    for (const n of YT_KIT_NAMES) expect(lines.filter((l) => l.startsWith(`- ${n} `) || l.startsWith(`- ${n}(`) || l.startsWith(`- ${n}:`)), n).toHaveLength(1);
    expect(docs).toContain("- Bulb {cx, cy, s?, glow?} - ");
    expect(docs).toContain("- Laptop {x, y, w?, opacity?, state?: \"code\" | \"ok\" | \"err\"} - ");
    expect(docs).toContain("- rotorAngle(frame: number, total: number, keys: readonly (readonly [number, number])[], sym: number) - ");
    expect(lines.every((l) => l.length < 260)).toBe(true);
  });
  it("turns a small declaration file into lines (number types are left out)", () => {
    const dts = `import type { FC } from "react";
/** Round thing. */
export const Dot: FC<{ x: number; label?: string; kind: "a" | "b" }>;
/** Add. */
export function add(a: number, b?: number): number;
export const K: string;
const hidden: FC<{ z: number }>;`;
    expect(kitExportNames(dts)).toEqual(["Dot", "add", "K"]);
    expect(kitDocs(dts)).toBe(`- Dot {x, label?: string, kind: "a" | "b"} - Round thing.\n- add(a: number, b?: number) - Add.\n- K: string`);
  });
  it("every documented export has a comment line", () => {
    for (const l of kitDocs(YT_KIT_DTS).split("\n")) if (!l.startsWith("- type ")) expect(l).toMatch(/ - \S/);
  });
});

describe("yt-kit safety helpers", () => {
  it("safeColor accepts hex, rgb()/rgba() and palette names, and refuses everything else", () => {
    for (const ok of ["#fff", "#ffff", "#6366F1", "#6366F1cc", "rgb(1, 2, 3)", "rgba(1,2,3,0.5)", "rgba(1,2,3,.25)"]) expect(safeColor(ok, "#000000")).toBe(ok);
    expect(safeColor("Indigo", "#000000")).toBe(PALETTE.indigo);
    expect(safeColor(" teal ", "#000000")).toBe(PALETTE.teal);
    for (const bad of ["url(https://evil/x)", "url(#a)", "#12", "#ggg", "rgb(1,2,3);background:url(x)", "rgb(1,2,3) !important", "expression(1)", "var(--x)", "constructor", "__proto__", "toString", "hasOwnProperty", "", "javascript:alert(1)", 5, null, undefined, {}, ["#fff"]]) {
      expect(safeColor(bad, "#123456"), String(bad)).toBe("#123456");
    }
  });
  it("num clamps and rejects non-numbers", () => {
    expect(num(5, 0, 1, 0.5)).toBe(1);
    expect(num(-5, 0, 1, 0.5)).toBe(0);
    for (const bad of [NaN, Infinity, -Infinity, "3", null, undefined, {}]) expect(num(bad, 0, 10, 7)).toBe(7);
  });
  it("txt only returns capped plain strings; fmt writes whole numbers with commas", () => {
    expect(txt("abcdef", 3)).toBe("abc");
    expect(txt(5)).toBe("");
    expect(txt({ toString: () => "x" })).toBe("");
    expect(fmt(1234567)).toBe("1,234,567");
    expect(fmt(-1234.6)).toBe("-1,235");
    expect(fmt(NaN)).toBe("0");
  });
  it("rotorAngle starts at 0 and ends on a multiple of the symmetry, for any speed keys", () => {
    const keys = [[0, 0], [30, 7.3], [100, 11.9], [150, 2]] as const;
    expect(rotorAngle(0, 180, keys, 45)).toBe(0);
    const end = rotorAngle(179, 180, keys, 45);
    expect(end % 45).toBeCloseTo(0, 6);
    expect(end).toBeGreaterThan(0);
    expect(rotorAngle(5, 180, [], 45)).toBe(0);
    expect(Number.isFinite(rotorAngle(NaN, NaN, keys, NaN))).toBe(true);
  });
  it("polyAt follows the polyline and wraps", () => {
    expect(polyAt([[0, 0], [10, 0]], 0.5)).toEqual([5, 0]);
    expect(polyAt([[0, 0], [10, 0]], 1.5)).toEqual([5, 0]);
    expect(polyAt([], 0.3)).toEqual([0, 0]);
  });
});

describe("yt-kit sources", () => {
  const files = readdirSync(LIB).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
  it("use no HTML injection, network, clock, timers or unseeded randomness; all carry the MIT notice or the barrel's pointer", () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const f of files) {
      const src = readFileSync(path.join(LIB, f), "utf8");
      for (const banned of ["dangerouslySetInnerHTML", "innerHTML", "Math.random", "Date.now", "new Date", "fetch(", "XMLHttpRequest", "setTimeout", "setInterval", "staticFile", "eval(", "http://", "https://", "url(http", "<img", "<script", "<style", "useState", "useEffect"]) expect(src.includes(banned), `${f}: ${banned}`).toBe(false);
      if (!f.endsWith(".d.ts")) expect(src, f).toMatch(/Hasan Aboul Hasan|yt-kit/);
    }
  });
});
