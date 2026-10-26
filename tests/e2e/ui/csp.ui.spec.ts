import { expect, test } from "@playwright/test";

// The no-nonce CSP (Doc 2 §9.5) must not block Next's own inline bootstrap scripts or hydration.
for (const path of ["/", "/login"]) {
  test(`no CSP violations and the page hydrates: ${path}`, async ({ page }) => {
    const bad: string[] = [];
    page.on("console", (m) => {
      if (/content security policy/i.test(m.text())) bad.push(m.text());
    });
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    expect(await page.evaluate(() => document.querySelectorAll("script").length)).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });
}
