import { readFileSync } from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NAV_ITEMS } from "@/ui/shell/nav-config";

// /dev/ui* is a design review aid: session first, then a 404 in production, and never in the nav.
const order: string[] = [];
vi.mock("@/lib/auth/require-owner", () => ({ requireOwner: vi.fn(async () => void order.push("requireOwner")) }));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    order.push("notFound");
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

const PAGES = [
  ["/dev/ui", "../../src/app/(app)/dev/ui/page"],
  ["/dev/ui/home", "../../src/app/(app)/dev/ui/home/page"],
  ["/dev/ui/video", "../../src/app/(app)/dev/ui/video/page"],
] as const;

// The default export is a sync shell around <Suspense><Owned/></Suspense>; Owned is the async part that holds the guards.
async function runOwned(mod: { default: () => React.ReactElement }) {
  const suspense = mod.default() as React.ReactElement<{ children: React.ReactElement<object> }>;
  const owned = suspense.props.children;
  return await (owned.type as (p: object) => Promise<unknown>)(owned.props);
}

afterEach(() => {
  vi.unstubAllEnvs();
  order.length = 0;
});

describe.each(PAGES)("%s", (url, rel) => {
  it("checks the session first and then 404s in production", async () => {
    const mod = await import(rel); // import first: React picks its JSX runtime from NODE_ENV at load time
    vi.stubEnv("NODE_ENV", "production");
    await expect(runOwned(mod)).rejects.toThrow("NEXT_NOT_FOUND");
    expect(order).toEqual(["requireOwner", "notFound"]);
  });
  it("renders in development, still after the session check", async () => {
    const mod = await import(rel);
    vi.stubEnv("NODE_ENV", "development");
    const html = renderToStaticMarkup((await runOwned(mod)) as React.ReactElement); // really renders, long Indic text included
    expect(html).toContain('data-testid="dev-ui"');
    expect(order).toEqual(["requireOwner"]);
  });
  it("is not in the nav", () => {
    expect(NAV_ITEMS.map((i) => i.href)).not.toContain(url);
  });
  it("source keeps requireOwner before notFound", () => {
    const src = readFileSync(path.resolve(__dirname, rel + ".tsx"), "utf8");
    expect(src.indexOf("await requireOwner()")).toBeGreaterThan(-1);
    expect(src.indexOf("await requireOwner()")).toBeLessThan(src.indexOf("notFound()"));
  });
});

it("no nav item lives under /dev", () => {
  expect(NAV_ITEMS.filter((i) => i.href.startsWith("/dev"))).toEqual([]);
});
