import { expect, test } from "@playwright/test";

// The e2e server is a PRODUCTION build, so the dev screens must be hidden even for the signed-in owner. (Under
// cacheComponents the not-found UI streams, so Next answers 200 with a noindex tag instead of a 404 status.)
// The development-mode behaviour (200 with the session) is covered in tests/unit/dev-ui-guard.test.ts.
for (const url of ["/dev/ui", "/dev/ui/home", "/dev/ui/video"]) {
  test(`${url} shows the not-found page, not the screen, in production`, async ({ page }) => {
    const res = await page.goto(url);
    expect([200, 404]).toContain(res!.status());
    await expect(page.locator('meta[name="robots"][content*="noindex"]').first()).toBeAttached();
    await expect(page.getByTestId("dev-ui")).toHaveCount(0);
    await expect(page.getByText("This page could not be found.")).toBeVisible();
  });
}

test("the nav never links to /dev", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('a[href^="/dev"]')).toHaveCount(0);
});
