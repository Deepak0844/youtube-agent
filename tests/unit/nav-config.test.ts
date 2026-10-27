import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FLAGS, isEnabled } from "@/lib/flags";
import { NAV_ITEMS, bottomBarItems, isActive, visibleNav } from "@/ui/shell/nav-config";

// Settings pages are built on their own branches (tasks 8-12, 18) and only the shell task may edit the nav, so their
// flags go on first. Each href leaves this list as its page lands; the list must be empty before Phase 1 closes.
const PAGE_ARRIVES_ON_ANOTHER_BRANCH = ["/settings/google", "/settings/audit", "/settings/system"];

const pageFile = (href: string) => {
  const dir = path.resolve("src/app/(app)", href === "/" ? "" : href.slice(1));
  return ["page.tsx", "page.ts"].some((f) => existsSync(path.join(dir, f)));
};

describe("nav config", () => {
  it("every item has label, href, group, phase and flag", () => {
    for (const i of NAV_ITEMS) {
      expect(i.label.length).toBeGreaterThan(0);
      expect(i.href.startsWith("/")).toBe(true);
      expect(i.group).toBeTruthy();
      expect(i.phase).toBeGreaterThanOrEqual(1);
      expect(i.flag.length).toBeGreaterThan(0);
    }
  });
  it("no duplicated hrefs or labels within a group", () => {
    expect(new Set(NAV_ITEMS.map((i) => i.href)).size).toBe(NAV_ITEMS.length);
    expect(new Set(NAV_ITEMS.map((i) => `${i.group}/${i.label}`)).size).toBe(NAV_ITEMS.length);
  });
  it("every flag an item names exists in the flag map", () => {
    for (const i of NAV_ITEMS) expect(Object.keys(FLAGS), i.flag).toContain(i.flag);
  });
  it("hidden flags are absent from the rendered nav", () => {
    const shown = visibleNav().flatMap((g) => g.items);
    expect(shown.every((i) => isEnabled(i.flag))).toBe(true);
    expect(shown.map((i) => i.href)).not.toContain("/queue");
    expect(shown.map((i) => i.label)).toEqual(["Home", "Models", "Keys", "Google app", "Audit", "System"]);
  });
  it("every enabled href resolves to an existing page file", () => {
    for (const i of NAV_ITEMS.filter((i) => isEnabled(i.flag) && !PAGE_ARRIVES_ON_ANOTHER_BRANCH.includes(i.href))) {
      expect(pageFile(i.href), i.href).toBe(true);
    }
  });
  it("the allow-list only names enabled items", () => {
    for (const h of PAGE_ARRIVES_ON_ANOTHER_BRANCH) expect(NAV_ITEMS.some((i) => i.href === h && isEnabled(i.flag)), h).toBe(true);
  });
  it("bottom bar shows at most 5 destinations (More counts as one) and loses nothing", () => {
    const b = bottomBarItems();
    expect(b.main.length + (b.more.length ? 1 : 0)).toBeLessThanOrEqual(5);
    expect(b.main[0]!.href).toBe("/");
    expect([...b.main, ...b.more].map((i) => i.href)).toEqual(visibleNav().flatMap((g) => g.items).map((i) => i.href));
  });
  it("active matching: Home only on /, others on their own subtree", () => {
    expect(isActive("/", "/")).toBe(true);
    expect(isActive("/", "/settings/keys")).toBe(false);
    expect(isActive("/settings/keys", "/settings/keys")).toBe(true);
    expect(isActive("/settings/keys", "/settings/keys/new")).toBe(true);
    expect(isActive("/settings/keys", "/settings/keysx")).toBe(false);
  });
});
