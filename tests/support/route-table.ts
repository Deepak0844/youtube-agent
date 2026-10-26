import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { isPublicPath } from "@/lib/auth/policy";
import { blank, exportedHandlers, PROXY_EXCLUDED, ROUTE_FILE, SOURCE_EXT } from "./route-guards";

// The route table is DERIVED from the files under src/app, never written by hand: a new page.tsx / route.ts shows up in
// every spec that iterates it. Shared by the Playwright session-required spec and its unit self-test.
export interface RouteEntry {
  url: string; // route-group and dynamic segments resolved: (app) vanishes, [id] becomes "x"
  file: string;
  kind: "page" | "route";
  /** HTTP methods a route.* file exports; pages answer GET (and POST for Server Actions). */
  methods: string[];
  isPublic: boolean;
  /** The proxy matcher skips this path, so the Host guard does not run there. */
  proxyExcluded: boolean;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Same rule as tests/unit/route-inventory.test.ts: groups "(x)" and parallel "@x" vanish, "[x]" becomes "x". */
export function urlOf(appDir: string, file: string): string {
  const segs = path
    .relative(appDir, path.dirname(file))
    .split(path.sep)
    .filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith("@"));
  return "/" + segs.map((s) => (s.startsWith("[") ? "x" : s)).join("/");
}

export function routeTable(appDir = path.resolve("src/app")): RouteEntry[] {
  return walk(appDir)
    .filter((f) => SOURCE_EXT.test(f) && ROUTE_FILE.test(f))
    .map((file) => {
      const url = urlOf(appDir, file);
      const kind = /(^|[\\/])route\./.test(file) ? "route" : "page";
      const methods = kind === "route" ? exportedHandlers(blank(readFileSync(file, "utf8"))).handlers.map((h) => h.name) : ["GET"];
      return {
        url,
        file,
        kind,
        methods,
        isPublic: isPublicPath(url),
        proxyExcluded: PROXY_EXCLUDED.some((p) => url === p || url.startsWith(p + "/")),
      } satisfies RouteEntry;
    })
    .sort((a, b) => a.url.localeCompare(b.url));
}
