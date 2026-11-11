import { expect, test, type Page } from "@playwright/test";

// The Policies page with the seeded owner's session. Only the public switch can change (typed phrase to turn on).
// (That nothing else can write a policy is pinned in tests/integration/policies.test.ts.)
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
  // one form only: the public switch. Nothing for the evidence rule.
  await expect(page.locator("main form")).toHaveCount(1);
});

// The wrong-phrase path only: the desktop and phone projects share one database and run side by side, so a test that really flips the switch would race
// the "safe defaults" test above. The right-phrase and turn-off paths are pinned in tests/integration/policies.test.ts.
test("the public switch refuses a wrong phrase and changes nothing", async ({ page }) => {
  await open(page);
  const form = page.getByTestId("public-form");
  await form.getByLabel("Allow public publishing").check();
  await form.getByLabel(/Type ALLOW PUBLIC/).fill("allow public");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form.getByRole("alert")).toContainText("Nothing was saved");
  await page.reload();
  await expect(page.getByTestId("policy-public")).toHaveText("Not allowed");
});

test("fits a phone: no sideways scroll", async ({ page }) => {
  await open(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});
