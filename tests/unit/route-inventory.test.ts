import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isPublicPath } from "@/lib/auth/policy";
import { ACTION_ALLOW, checkActionFile, checkRoute, ROUTE_FILE, SOURCE_EXT } from "../support/route-guards";

const APP = path.resolve("src/app");
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
// Route groups "(x)" vanish from the URL; dynamic "[x]" segments become a placeholder.
function urlOf(file: string): string {
  const segs = path.relative(APP, path.dirname(file)).split(path.sep).filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith("@"));
  return "/" + segs.map((s) => (s.startsWith("[") ? "x" : s)).join("/");
}
const files = walk(path.resolve("src")).filter((f) => SOURCE_EXT.test(f));
const routes = files.filter((f) => f.startsWith(APP) && ROUTE_FILE.test(f));
const actionFiles = files.filter((f) => /["']use server["']/.test(readFileSync(f, "utf8")));

describe("route inventory (real files)", () => {
  it("finds the known routes and actions", () => {
    expect(routes.length).toBeGreaterThanOrEqual(8);
    expect(actionFiles.length).toBeGreaterThanOrEqual(3);
  });
  it.each(routes.map((f) => [urlOf(f), f]))("%s is public or properly guarded", (url, file) => {
    const v = checkRoute({ url: url!, file: file!, src: readFileSync(file!, "utf8"), isPublic: isPublicPath(url!) });
    expect(v, `${file}`).toEqual([]);
  });
  it.each(actionFiles)("server actions in %s authenticate", (file) => {
    expect(checkActionFile(readFileSync(file, "utf8")), file).toEqual([]);
  });
  it("only the three public actions are exempt", () => expect(ACTION_ALLOW).toEqual(["loginAction", "setupAction", "logoutAction"]));
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

describe("checkers (synthetic sources)", () => {
  const route = (src: string, url = "/api/x") => checkRoute({ url, file: "src/app/api/x/route.ts", src, isPublic: false });
  it("recognises every source extension", () => {
    for (const f of ["a/page.jsx", "a/page.js", "a/route.mjs", "a/route.cjs", "a/page.tsx"]) expect(ROUTE_FILE.test(f), f).toBe(true);
    expect(ROUTE_FILE.test("a/pager.tsx")).toBe(false);
  });
  it("a .jsx page without a guard fails", () => {
    expect(checkRoute({ url: "/x", file: "src/app/x/page.jsx", src: "export default function P(){return null}", isPublic: false })).not.toEqual([]);
  });
  it("a page that only mentions requireOwner in a comment fails", () => {
    expect(checkRoute({ url: "/x", file: "src/app/x/page.tsx", src: "// await requireOwner()\nexport default function P(){}", isPublic: false })).not.toEqual([]);
  });
  it("a page with requireOwner passes; a public page needs none", () => {
    expect(checkRoute({ url: "/x", file: "src/app/x/page.tsx", src: "await requireOwner();", isPublic: false })).toEqual([]);
    expect(checkRoute({ url: "/login", file: "src/app/login/page.tsx", src: "", isPublic: true })).toEqual([]);
  });
  it("a route that ignores the requireOwnerApi result fails", () => {
    expect(route("export async function GET(r){ await requireOwnerApi(r); return Response.json({}) }")).not.toEqual([]);
    expect(route("export async function GET(r){ const o = await requireOwnerApi(r); return Response.json({}) }")).not.toEqual([]);
    expect(route("export async function GET(r){ const o = await requireOwnerApi(r); if (o instanceof Response) return Response.json({}); return o }")).not.toEqual([]);
  });
  it("a route with a proper guard passes", () => {
    expect(route("export async function GET(r){ const o = await requireOwnerApi(r); if (o instanceof Response) return o; return Response.json({}) }")).toEqual([]);
    expect(route("export async function GET(r){ const g = await requireOwnerApi(r);\n if (g instanceof Response) { return g; } }")).toEqual([]);
  });
  it("routes the proxy skips must call the host/origin guard", () => {
    const pub = (url: string, src: string) => checkRoute({ url, file: "src/app/api/media/route.ts", src, isPublic: true });
    for (const url of ["/api/uploads", "/api/media/x", "/api/webhooks/stripe", "/api/events", "/api/oauth/callback"]) {
      expect(pub(url, "export function GET(){}"), url).not.toEqual([]);
      expect(pub(url, "const e = assertAllowedHost(r)"), url).toEqual([]);
      expect(pub(url, "const e = assertSameOrigin(r)"), url).toEqual([]);
    }
    expect(pub("/api/v1/x", "export function GET(){}")).toEqual([]);
  });
  it("server actions must call requireOwner unless allow-listed", () => {
    const head = '"use server";\n';
    expect(checkActionFile(head + "export async function deleteAll(){ await db.q() }")).not.toEqual([]);
    expect(checkActionFile(head + "export async function deleteAll(){ await requireOwner(); await db.q() }")).toEqual([]);
    expect(checkActionFile(head + "export const del = async () => { await db.q() }")).not.toEqual([]);
    expect(checkActionFile(head + "export async function loginAction(){}\nexport async function logoutAction(){}")).toEqual([]);
    expect(checkActionFile(head + "export async function loginAction(){}\nexport async function other(){ if (x) { y() } }")).not.toEqual([]);
    expect(checkActionFile(head + "async function a(){}\nexport { a }")).not.toEqual([]);
    expect(checkActionFile(head + "export default async function a(){}")).not.toEqual([]);
    expect(checkActionFile("export async function f(){ 'use server'; await db.q() }")).not.toEqual([]);
    expect(checkActionFile("export function plain(){}")).toEqual([]);
  });
});
