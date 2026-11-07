import { expect, test } from "@playwright/test";

// Runs with the seeded owner's session. CI has no pg_dump on the web host's PATH guarantee, so only the shape is asserted:
// after Back up now the page shows either the last-backup line or the red Backup failed banner, never nothing.
test("Back up now shows a result", async ({ page }) => {
  await page.goto("/settings/system");
  await expect(page.getByRole("heading", { name: "Backups" })).toBeVisible();
  await page.getByRole("button", { name: "Back up now" }).click();
  await expect(page.getByTestId("backup-last").or(page.getByTestId("backup-failed"))).toContainText(/Last backup|Backup failed/);
});
