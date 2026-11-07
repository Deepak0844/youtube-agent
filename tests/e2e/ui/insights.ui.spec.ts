import { expect, test } from "@playwright/test";

// Runs with the seeded owner's session. A fresh database has no uploaded shorts, so the review is numbers only and says so.
test("Analytics: run a weekly review and see it labelled low confidence", async ({ page }) => {
  await page.goto("/analytics");
  await expect(page.getByRole("heading", { name: "Weekly review", level: 2 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Proposals", level: 2 })).toBeVisible();

  await page.getByRole("button", { name: "Run review now" }).click();
  await expect(page.getByTestId("review-note")).toContainText("Weekly review");
  await expect(page.getByTestId("review")).toBeVisible();
  await expect(page.getByTestId("low-confidence")).toContainText("Low confidence");
  await expect(page.getByTestId("review")).toContainText("Shipped");
  await expect(page.getByTestId("review")).toContainText("Cost per short");

  // The optimizer button answers in plain words (a fresh database has no model and too few shorts, so it only says why it did nothing).
  await page.getByRole("button", { name: "Run optimizer now" }).click();
  await expect(page.getByTestId("optimizer-note")).not.toBeEmpty();
});
