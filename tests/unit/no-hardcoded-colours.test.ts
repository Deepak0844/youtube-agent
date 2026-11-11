import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Light and dark both come from tokens.css. A hard-coded colour in a screen shows up as a black (or white) box in the
// other theme. The video style samples draw the videos themselves, so they keep their own colours.
const SKIP = [/src\/ui\/sample\//, /src\/ui\/kit\//, /src\/remotion\//, /videos\/new\/style-mock\.tsx$/];
const walk = (d: string): string[] =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".tsx") ? [join(d, e.name)] : []));

describe("no hard-coded colours in screens", () => {
  const files = [...walk("src/app"), ...walk("src/ui")].filter((f) => !SKIP.some((r) => r.test(f)));
  it.each(files)("%s", (f) => {
    const s = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(s).not.toMatch(/["'`\s(:]#[0-9a-fA-F]{3,8}\b/);
    expect(s).not.toMatch(/\b(bg|text|border|from|to|fill|stroke)-(black|white)\b/);
  });
});
