import { expect, test } from "@playwright/test";

// Runs with the seeded owner's session. Overnight drafting spends money, so turning it on needs the confirmation box.
test("Schedule: drafting needs the spend confirmation, other settings save", async ({ page }) => {
  await page.goto("/settings/schedule");
  await expect(page.getByRole("heading", { name: "Schedule", level: 1 })).toBeVisible();

  await page.getByLabel("Draft videos overnight").check();
  await page.getByRole("button", { name: "Save schedule" }).click();
  await expect(page.getByRole("alert")).toContainText("confirm that overnight drafting spends money");

  await page.getByLabel(/I understand overnight drafting spends money/).check();
  await page.getByLabel("Drafts per night").fill("1");
  await page.getByRole("button", { name: "Save schedule" }).click();
  await expect(page.getByRole("status")).toContainText("Saved.");

  // put it back so other specs see the default
  await page.getByLabel("Draft videos overnight").uncheck();
  await page.getByLabel("Drafts per night").fill("2");
  await page.getByRole("button", { name: "Save schedule" }).click();
  await expect(page.getByRole("status")).toContainText("Saved.");
});
