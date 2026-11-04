import { expect, test } from "@playwright/test";

// Runs with the seeded owner's session. Only looks at the page frame: pressing Run now would call Google, which e2e never does.
test("the Analytics page loads with its Run now button and a nav link", async ({ page }) => {
  await page.goto("/analytics");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { level: 1, name: "Analytics" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run now" })).toBeVisible();
});
