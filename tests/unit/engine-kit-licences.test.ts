import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Everything imported from the old app (old-kit-import spec) carries a licence line, and the old drawing libraries never reach
// the network (the render box has none, and a leftover Google-font download would break or leak).

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const LICENCES = readFileSync("engine-kit/LICENSES.md", "utf8");
const imported = () => [...walk("remotion/kit/oldlib"), ...walk("engine-kit")].filter((f) => f !== path.join("engine-kit", "LICENSES.md") && !f.includes(`${path.sep}types${path.sep}`));

describe("engine kit licences", () => {
  it("every_imported_file_has_a_licence_line", () => {
    const missing = imported().filter((f) => !LICENCES.includes(f.split(path.sep).join("/")));
    expect(missing).toEqual([]);
  });

  it("no_network_imports_in_oldlib", () => {
    for (const f of walk("remotion/kit/oldlib").filter((x) => /\.(tsx?|mjs|js)$/.test(x))) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/@remotion\/google-fonts|fetch\(|https?:\/\/|XMLHttpRequest|WebSocket|import\(/);
    }
  });
});
