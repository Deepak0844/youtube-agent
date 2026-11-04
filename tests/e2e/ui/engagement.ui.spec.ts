import { expect, test } from "@playwright/test";

// Runs with the seeded owner's session. Only looks at the page frame: pressing Run now would call Google, which e2e never does,
// and Approve and post is never pressed here.
test("the Engagement page loads with Run now, the dry-run banner and today's reply count", async ({ page }) => {
  await page.goto("/engagement");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { level: 1, name: "Engagement" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run now" })).toBeVisible();
  await expect(page.getByTestId("dry-run-banner")).toContainText("Dry run is on");
  await expect(page.getByTestId("last-sync")).toContainText("Never synced");
  await expect(page.getByRole("heading", { level: 2, name: /Replies waiting for you/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve and post" })).toHaveCount(0);
});
