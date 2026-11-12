import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FLAGS, isEnabled } from "@/lib/flags";
import { AREAS, NAV_ITEMS, areaFor, bottomBarItems, isActive, visibleAreas } from "@/ui/shell/nav-config";

// Settings pages are built on their own branches (tasks 8-12, 18) and only the shell task may edit the nav, so their
// flags go on first. Each href leaves this list as its page lands; the list must be empty before Phase 1 closes.
const PAGE_ARRIVES_ON_ANOTHER_BRANCH: string[] = [];

const pageFile = (href: string) => {
  const dir = path.resolve("src/app/(app)", href === "/" ? "" : href.slice(1));
  return ["page.tsx", "page.ts"].some((f) => existsSync(path.join(dir, f)));
};

describe("nav config", () => {
  it("every item has label, href, area, phase and flag; Settings items have a section", () => {
    for (const i of NAV_ITEMS) {
      expect(i.label.length).toBeGreaterThan(0);
      expect(i.href.startsWith("/")).toBe(true);
      expect(AREAS).toContain(i.area);
      expect(Boolean(i.section), i.href).toBe(i.area === "Settings");
      expect(i.phase).toBeGreaterThanOrEqual(1);
      expect(i.flag.length).toBeGreaterThan(0);
    }
  });
  it("no duplicated hrefs or labels within a group", () => {
    expect(new Set(NAV_ITEMS.map((i) => i.href)).size).toBe(NAV_ITEMS.length);
    expect(new Set(NAV_ITEMS.map((i) => `${i.area}/${i.label}`)).size).toBe(NAV_ITEMS.length);
  });
  it("every flag an item names exists in the flag map", () => {
    for (const i of NAV_ITEMS) expect(Object.keys(FLAGS), i.flag).toContain(i.flag);
  });
  it("hidden flags are absent; areas and their menus follow the spec (§4.2)", () => {
    const areas = visibleAreas();
    const shown = areas.flatMap((a) => a.items);
    expect(shown.every((i) => isEnabled(i.flag))).toBe(true);
    expect(areas.map((a) => a.area)).toEqual(["Home", "Make", "Plan", "Publish", "Settings"]);
    const labels = (name: string) => areas.find((a) => a.area === name)!.items.map((i) => i.label);
    expect(labels("Home")).toEqual(["Home"]);
    expect(labels("Make")).toEqual(["Queue", "Videos", "New video", "Ideas", "Series", "Assets"]);
    expect(labels("Plan")).toEqual(["Calendar", "Research", "Targets"]);
    expect(labels("Publish")).toEqual(["Engagement", "Analytics"]);
    const settings = areas.find((a) => a.area === "Settings")!;
    expect(settings.sections!.map((s) => [s.section, s.items.map((i) => i.label)])).toEqual([
      ["You", ["Account", "Channels", "Google app", "Notifications"]],
      ["AI and media", ["Models", "Providers", "Keys", "Assets"]],
      ["Money and safety", ["Budgets", "Policies", "Schedule"]],
      ["System", ["System", "Audit log", "API tokens"]],
    ]);
  });
  it("an area links to its first enabled page", () => {
    const hrefs = Object.fromEntries(visibleAreas().map((a) => [a.area, a.href]));
    expect(hrefs).toEqual({ Home: "/", Make: "/queue", Plan: "/calendar", Publish: "/engagement", Settings: "/settings/account" });
  });
  it("areaFor maps any path to its area", () => {
    expect(areaFor("/")).toBe("Home");
    expect(areaFor("/videos/abc")).toBe("Make");
    expect(areaFor("/videos/new")).toBe("Make");
    expect(areaFor("/settings/keys")).toBe("Settings");
    expect(areaFor("/calendar")).toBe("Plan");
    expect(areaFor("/analytics")).toBe("Publish");
    expect(areaFor("/onboarding")).toBe("Home");
  });
  it("every enabled href resolves to an existing page file", () => {
    for (const i of NAV_ITEMS.filter((i) => isEnabled(i.flag) && !PAGE_ARRIVES_ON_ANOTHER_BRANCH.includes(i.href))) {
      expect(pageFile(i.href), i.href).toBe(true);
    }
  });
  it("the allow-list only names enabled items", () => {
    for (const h of PAGE_ARRIVES_ON_ANOTHER_BRANCH) expect(NAV_ITEMS.some((i) => i.href === h && isEnabled(i.flag)), h).toBe(true);
  });
  it("phone bottom bar shows the five areas", () => {
    expect(bottomBarItems().map((a) => a.area)).toEqual(["Home", "Make", "Plan", "Publish", "Settings"]);
  });
  it("active matching: Home only on /, others on their own subtree", () => {
    expect(isActive("/", "/")).toBe(true);
    expect(isActive("/", "/settings/keys")).toBe(false);
    expect(isActive("/settings/keys", "/settings/keys")).toBe(true);
    expect(isActive("/settings/keys", "/settings/keys/new")).toBe(true);
    expect(isActive("/settings/keys", "/settings/keysx")).toBe(false);
  });
  it("Videos is active on a video page but not on New, which has its own item", () => {
    expect(isActive("/videos", "/videos")).toBe(true);
    expect(isActive("/videos", "/videos/abc")).toBe(true);
    expect(isActive("/videos", "/videos/new")).toBe(false);
    expect(isActive("/videos/new", "/videos/new")).toBe(true);
  });
});
