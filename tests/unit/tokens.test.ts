import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const tokensCss = readFileSync("src/ui/tokens.css", "utf8");

/** Parse `--name: value;` pairs from the first :root block. */
function rootTokens(css: string): Record<string, string> {
  const block = /:root\s*\{([\s\S]*?)\n\}/.exec(css);
  if (!block) throw new Error("no :root block in tokens.css");
  const out: Record<string, string> = {};
  const body = (block[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1] ?? ""] = (m[2] ?? "").trim();
  return out;
}
const raw = rootTokens(tokensCss);
const g = (k: string): string => raw[k] ?? "";

function rgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}
function lin3(hex: string): [number, number, number] {
  const [r, g, b] = rgb(hex);
  return [lin(r), lin(g), lin(b)];
}
function lin(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
function luminance(hex: string): number {
  const [r, g, b] = lin3(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const hi = Math.max(luminance(a), luminance(b));
  const lo = Math.min(luminance(a), luminance(b));
  return (hi + 0.05) / (lo + 0.05);
}
function lab(hex: string): [number, number, number] {
  const [r, g, b] = lin3(hex);
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (v: number) => (v > 216 / 24389 ? Math.cbrt(v) : (24389 / 27 * v + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
function deltaE(a: string, b: string): number {
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

describe("tokens.css parsing", () => {
  it("has the Doc 3 colour tokens as hex", () => {
    for (const k of ["--ground", "--surface", "--raised", "--text", "--muted", "--faint", "--accent", "--warning"]) {
      expect(g(k), k).toMatch(/^#[0-9a-f]{3,6}$/i);
    }
  });
  it("keeps the dealt values", () => {
    expect(g("--ground")).toBe("#000");
    expect(g("--accent")).toBe("#f2a33a");
    expect(g("--radius-card")).toBe("20px");
  });
});

describe("contrast (WCAG AA 4.5:1 for text)", () => {
  it.each([
    ["--faint", "--ground"],
    ["--faint", "--surface"],
    ["--faint", "--raised"],
    ["--muted", "--ground"],
    ["--muted", "--surface"],
    ["--muted", "--raised"],
    ["--text", "--ground"],
    ["--text", "--raised"],
    ["--accent", "--ground"],
    ["--accent", "--surface"],
  ])("%s on %s", (fg, bg) => {
    expect(contrast(g(fg), g(bg))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(["positive", "negative", "warning", "neutral"])("pill %s ink on its background", (k) => {
    expect(contrast(g(`--pill-${k}-ink`), g(`--pill-${k}-bg`))).toBeGreaterThanOrEqual(4.5);
  });

  it("raw --negative would not pass on its pill (why the lighter ink exists)", () => {
    expect(contrast(g("--pill-negative-ink"), g("--pill-negative-bg"))).toBeGreaterThan(
      contrast(g("--negative"), g("--pill-negative-bg")),
    );
  });

  it("control border is visible against ground (3:1 for UI components)", () => {
    expect(contrast(g("--control"), g("--ground"))).toBeGreaterThanOrEqual(2);
    expect(contrast(g("--control"), g("--surface"))).toBeGreaterThanOrEqual(1.8);
  });
});

describe("hue separation", () => {
  it("amber and warning yellow are measurably apart in CIELAB", () => {
    expect(deltaE(g("--accent"), g("--warning"))).toBeGreaterThanOrEqual(10);
  });
  it("accent, positive and negative are far apart", () => {
    expect(deltaE(g("--accent"), g("--positive"))).toBeGreaterThanOrEqual(30);
    expect(deltaE(g("--accent"), g("--negative"))).toBeGreaterThanOrEqual(30);
  });
  it("elevation steps are strictly lighter", () => {
    expect(luminance(g("--ground"))).toBeLessThan(luminance(g("--surface")));
    expect(luminance(g("--surface"))).toBeLessThan(luminance(g("--raised")));
  });
});

describe("type scale", () => {
  it("no --fs-* token is below 11px", () => {
    const sizes = Object.entries(raw).filter(([k]) => k.startsWith("--fs-"));
    expect(sizes.length).toBeGreaterThanOrEqual(6);
    for (const [k, v] of sizes) {
      const m = /^(\d+(?:\.\d+)?)px$/.exec(v);
      expect(m, `${k}=${v}`).not.toBeNull();
      expect(Number(m![1]), k).toBeGreaterThanOrEqual(11);
    }
  });
  it("no font-size declaration in the UI css is below 11px", () => {
    for (const f of ["src/ui/tokens.css", "src/app/globals.css"]) {
      for (const m of readFileSync(f, "utf8").matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px/g)) {
        expect(Number(m[1]), f).toBeGreaterThanOrEqual(11);
      }
    }
  });
});

describe("fonts are self-hosted", () => {
  const fontsTs = readFileSync("src/ui/fonts.ts", "utf8");
  const files = [...fontsTs.matchAll(/["'](\.\.\/\.\.\/public\/fonts\/[\w.-]+\.woff2)["']/g)].map((m) => m[1] ?? "");

  it("fonts.ts references woff2 files that exist", () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
    for (const f of files) expect(existsSync(join("src/ui", f)), f).toBe(true);
  });
  it("covers Instrument Sans and every Indic script", () => {
    for (const n of ["instrument-sans", "devanagari", "tamil", "telugu", "malayalam", "kannada"]) {
      expect(files.some((f) => f.includes(n)), n).toBe(true);
    }
  });
  it("every vendored family ships its OFL licence text", () => {
    for (const f of readdirSync("public/fonts").filter((x) => x.endsWith(".woff2"))) {
      const fam = f.replace(/-(latin|latin-ext)?\.woff2$|\.woff2$/, "");
      const lic = `public/fonts/licences/${fam}.OFL.txt`;
      expect(existsSync(lic), lic).toBe(true);
      expect(readFileSync(lic, "utf8")).toContain("SIL OPEN FONT LICENSE Version 1.1");
    }
  });
  it("SHA256SUMS lists every font file", () => {
    const sums = readFileSync("public/fonts/SHA256SUMS.txt", "utf8");
    for (const f of readdirSync("public/fonts").filter((x) => x.endsWith(".woff2"))) {
      expect(sums).toContain(f);
      expect(statSync(`public/fonts/${f}`).size).toBeGreaterThan(10_000);
    }
  });
  it("no Google font CDN or next/font/google anywhere in src/", () => {
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(d, e.name)) : /\.(tsx?|css|mts)$/.test(e.name) ? [join(d, e.name)] : [],
      );
    for (const f of walk("src")) {
      const s = readFileSync(f, "utf8");
      expect(s, f).not.toMatch(/fonts\.googleapis|fonts\.gstatic|next\/font\/google/);
    }
  });
  it("built CSS (if a build exists) has no Google font host", () => {
    const dir = ".next/static/chunks";
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".css"))) {
      expect(readFileSync(join(dir, f), "utf8"), f).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
    }
  });
});
