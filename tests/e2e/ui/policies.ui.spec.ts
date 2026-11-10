import { expect, test, type Page } from "@playwright/test";

// The Policies page with the seeded owner's session. It is READ ONLY: it shows the publishing rules and never changes them, so these tests only
// look. (That nothing on the page can write a policy is pinned in tests/integration/policies.test.ts.)
async function open(page: Page) {
  await page.goto("/settings/policies");
  await expect(page.getByRole("heading", { level: 1, name: "Policies" })).toBeVisible();
}

test("a visitor without a session sees no policy content", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  try {
    await page.goto("/settings/policies");
    await page.waitForURL(/\/login/);
    await expect(page.getByText("Publishing rules")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("shows the safe defaults and what would have to be true for a video to go public, with nothing to change", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("public-summary")).toContainText("private or unlisted only");
  await expect(page.getByTestId("policy-evidence")).toHaveText("Required");
  await expect(page.getByTestId("policy-public")).toHaveText("Not allowed");
  const reqs = page.getByTestId("public-requirements").getByRole("listitem");
  await expect(reqs).toHaveCount(4);
  await expect(reqs.filter({ hasText: "Per channel" })).toHaveCount(1);
  // read only: no control on the page changes a setting
  await expect(page.locator("main form")).toHaveCount(0);
  await expect(page.locator("main input")).toHaveCount(0);
});

test("fits a phone: no sideways scroll", async ({ page }) => {
  await open(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});
