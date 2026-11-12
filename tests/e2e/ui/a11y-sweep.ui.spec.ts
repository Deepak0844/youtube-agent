import { expect, test, type Page } from "@playwright/test";

// Phase 9 accessibility pass: every main screen, at desktop and phone width (both projects run this file), must have
// no axe violations (WCAG 2.0/2.1 A and AA), no sideways page scroll, one top-level heading, and a keyboard Tab that lands on something real.
const PAGES = [
  "/", "/queue", "/videos", "/videos/new", "/series", "/series/new", "/ideas", "/research", "/targets", "/calendar", "/analytics", "/engagement", "/assets",
  "/settings/account", "/settings/assets", "/settings/audit", "/settings/budgets", "/settings/channels", "/settings/google", "/settings/keys",
  "/settings/models", "/settings/notifications", "/settings/policies", "/settings/providers", "/settings/schedule", "/settings/system", "/settings/tokens",
];

async function axeViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
  return page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<{ violations: Array<{ id: string; nodes: Array<{ target: unknown[] }> }> }> } }).axe;
    const r = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => String(n.target)).slice(0, 3).join(" | ")}`);
  });
}

for (const path of PAGES) {
  test(`accessibility sweep ${path}`, async ({ page }) => {
    const res = await page.goto(path);
    test.skip(res?.status() === 404, "screen is switched off by its feature flag");
    expect(res?.status()).toBeLessThan(400);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    expect(await axeViolations(page)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.tagName ?? "BODY")).not.toBe("BODY");
  });
}

// Both themes (UI redesign spec §4.6.11): the run above follows the browser's light setting; this pass asks for dark.
// Desktop only, to keep the suite short; the phone layout uses the same colour tokens.
test.describe("dark theme", () => {
  test.use({ colorScheme: "dark" });
  for (const path of PAGES) {
    test(`accessibility sweep (dark) ${path}`, async ({ page }) => {
      test.skip((page.viewportSize()?.width ?? 1440) < 768, "desktop only");
      const res = await page.goto(path);
      test.skip(res?.status() === 404, "screen is switched off by its feature flag");
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("dark");
      expect(await axeViolations(page)).toEqual([]);
    });
  }
});
