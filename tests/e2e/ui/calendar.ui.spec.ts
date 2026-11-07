import { expect, test } from "@playwright/test";

// Runs with the seeded owner's session. Read only page: checks the frame and the link to the settings page.
test("Calendar: panels load and settings are changed elsewhere", async ({ page }) => {
  await page.goto("/calendar");
  await expect(page.getByRole("heading", { name: "Calendar", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Overnight drafting", level: 2 })).toBeVisible();
  await expect(page.getByTestId("next-window")).toContainText("IST");
  await expect(page.getByTestId("count-waiting")).toBeVisible();
  await expect(page.getByTestId("money-left")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent scheduler activity", level: 2 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Idea backlog", level: 2 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Upload queue", level: 2 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Uploaded", level: 2 })).toBeVisible();
  await page.getByRole("link", { name: "Settings, Schedule" }).click();
  await expect(page.getByRole("heading", { name: "Schedule", level: 1 })).toBeVisible();
});
