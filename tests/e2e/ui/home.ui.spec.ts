import { expect, test } from "@playwright/test";
import { installFakeClock } from "../fixtures/fake-clock";

test("home renders a heading", async ({ page }) => {
  await installFakeClock(page, "2026-01-01T09:00:00Z");
  await page.goto("/");
  await expect(page.locator("h1").first()).toBeVisible();
});
