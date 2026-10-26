import { expect, test } from "@playwright/test";
import { installFakeClock } from "../fixtures/fake-clock";

// Runs with the seeded owner's storageState (playwright.config.mts), i.e. reuse of a real session.
test("home renders a heading for the signed-in owner", async ({ page }) => {
  await installFakeClock(page, "2026-01-01T09:00:00Z");
  await page.goto("/");
  await expect(page.locator("h1").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "YT Studio" })).toBeVisible();
});
