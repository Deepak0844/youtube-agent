import { expect, test } from "@playwright/test";

// Runs with the seeded owner's session. Starting targets, then a replaced target and a delete.
test("Targets: starting targets, change one, delete it", async ({ page }) => {
  await page.goto("/targets");
  await expect(page.getByRole("heading", { name: "Targets", level: 1 })).toBeVisible();

  await page.getByRole("button", { name: "Use the starting targets" }).click();
  await expect(page.getByTestId("target-row")).toHaveCount(2);

  await page.getByLabel("What to measure").selectOption("avg_view_pct");
  await page.getByLabel("Target", { exact: true }).fill("65");
  await page.getByRole("button", { name: "Save target" }).click();
  await expect(page.getByTestId("target-row").filter({ hasText: "Average view %" })).toContainText("at least 65%");

  for (const label of ["Average view %", "Cost per short"]) {
    await page.getByRole("button", { name: `Delete target: ${label}` }).click();
    await expect(page.getByRole("button", { name: `Delete target: ${label}` })).toHaveCount(0);
  }
  await expect(page.getByText("No targets yet.")).toBeVisible();
});
