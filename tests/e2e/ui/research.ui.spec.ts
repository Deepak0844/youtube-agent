import { expect, test } from "@playwright/test";

// Runs with the seeded owner's session. Only looks at the page frame: pressing a button would call YouTube, Hacker News or
// Wikimedia, which e2e never does.
test("Research: page loads with the search counter, trend lists and a nav link", async ({ page }) => {
  await page.goto("/research");
  await expect(page.getByRole("heading", { name: "Research", level: 1 })).toBeVisible();
  await expect(page.getByTestId("search-counter")).toHaveText("Searches today: 0 of 100");
  await expect(page.getByRole("heading", { name: "Trends", level: 2 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh trends" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Research", exact: true })).toBeVisible();
});
