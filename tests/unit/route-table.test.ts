import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkRoute } from "../support/route-guards";
import { routeTable } from "../support/route-table";

// Self-test of the derived table that tests/e2e/api/session-required.api.spec.ts iterates: a brand-new route must appear
// in it, as protected, and the guard checker must flag it when it has no guard.
const tmp = mkdtempSync(path.join(os.tmpdir(), "route-table-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const put = (rel: string, src: string) => {
  const f = path.join(tmp, rel);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, src);
  return f;
};

describe("routeTable (derived from files)", () => {
  it("lists a new unguarded page and api route as protected, with the right urls and methods", () => {
    put("(app)/shiny/page.tsx", "export default function P(){ return null }");
    put("(app)/shiny/[id]/page.tsx", "export default function P(){ return null }");
    put("api/shiny/route.ts", "export async function GET(){ return Response.json({}) }\nexport async function DELETE(){ return Response.json({}) }");
    put("login/page.tsx", "export default function P(){ return null }");
    const t = routeTable(tmp);
    expect(t.map((r) => r.url)).toEqual(["/api/shiny", "/login", "/shiny", "/shiny/x"]);
    expect(t.find((r) => r.url === "/api/shiny")).toMatchObject({ kind: "route", methods: ["GET", "DELETE"], isPublic: false, proxyExcluded: false });
    expect(t.find((r) => r.url === "/shiny")).toMatchObject({ kind: "page", isPublic: false });
    expect(t.find((r) => r.url === "/login")!.isPublic).toBe(true);
  });

  it("the guard checker fails every non-public entry of that table (no guard in the fixtures)", () => {
    const protectedEntries = routeTable(tmp).filter((x) => !x.isPublic);
    expect(protectedEntries.length).toBeGreaterThan(0);
    for (const r of protectedEntries) {
      expect(checkRoute({ url: r.url, file: r.file, src: readFileSync(r.file, "utf8"), isPublic: false }), r.url).not.toEqual([]);
    }
  });

  it("marks proxy-excluded paths", () => {
    put("api/uploads/route.ts", "export async function POST(){ return Response.json({}) }");
    expect(routeTable(tmp).find((r) => r.url === "/api/uploads")!.proxyExcluded).toBe(true);
  });

  it("the real table is non-empty and every entry has a method", () => {
    const real = routeTable();
    expect(real.length).toBeGreaterThanOrEqual(8);
    for (const r of real) expect(r.methods.length, r.url).toBeGreaterThan(0);
  });
});
