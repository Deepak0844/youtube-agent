import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isPublicPath } from "@/lib/auth/policy";

const APP = path.resolve("src/app");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// Route groups "(x)" vanish from the URL; dynamic "[x]" and catch-all segments become a placeholder.
function urlOf(file: string): string {
  const segs = path.relative(APP, path.dirname(file)).split(path.sep).filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith("@"));
  return "/" + segs.map((s) => (s.startsWith("[") ? "x" : s)).join("/");
}

const routes = walk(APP).filter((f) => /[\\/](page|route)\.(ts|tsx)$/.test(f));

describe("route inventory", () => {
  it("finds the known routes", () => expect(routes.length).toBeGreaterThanOrEqual(8));
  it.each(routes.map((f) => [urlOf(f), f]))("%s is public or calls requireOwner", (url, file) => {
    const src = readFileSync(file as string, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1"); // comments do not count
    const guarded = /\brequireOwner(Api)?\s*\(/.test(src);
    expect(isPublicPath(url as string) || guarded, `${file} (${url}) is neither public nor guarded`).toBe(true);
    // A public route must not be guarded by accident of a comment either way: public AND guarded is allowed (logout-style), nothing to assert.
  });
  it("a public prefix never hides a guarded-looking route", () => {
    // /api/me must stay protected even though other /api/* paths are public.
    expect(isPublicPath("/api/me")).toBe(false);
  });
  it("uses proxy.ts, never middleware", () => {
    expect(existsSync("src/proxy.ts")).toBe(true);
    for (const f of ["src/middleware.ts", "src/middleware.js", "middleware.ts", "middleware.js"]) expect(existsSync(f)).toBe(false);
  });
  it("proxy.ts imports the shared policy and excludes the documented paths", () => {
    const src = readFileSync("src/proxy.ts", "utf8");
    expect(src).toContain("@/lib/auth/policy");
    for (const p of ["api/uploads", "api/media", "api/webhooks", "api/events", "api/oauth", "_next/static", "_next/image", "favicon"]) expect(src).toContain(p);
  });
});
