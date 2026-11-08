import { expect, test } from "@playwright/test";

// Runs with the seeded owner's session. Starting a part makes a normal draft that waits at its first step; nothing is approved or uploaded.
test("Series: create, plan episodes, reorder, drop, start a part", async ({ page }) => {
  const stamp = Date.now().toString(36);
  const title = `Series ${stamp}`;
  await page.goto("/series/new");
  await expect(page.getByRole("heading", { name: "New series", level: 1 })).toBeVisible();
  await page.getByLabel("Title").fill(title);
  await page.getByLabel(/Spend cap/).fill("5");
  await page.getByRole("button", { name: "Create series" }).click();
  await expect(page).toHaveURL(/\/series\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();
  await expect(page.getByText("of $5.00", { exact: false })).toBeVisible();

  await page.getByLabel(/One episode per line/).fill(`Alpha${stamp} - first one\nBeta${stamp} - second one\nGamma${stamp}`);
  await page.getByRole("button", { name: "Add to the plan" }).click();
  const items = page.getByRole("listitem").filter({ hasText: "Part " });
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toContainText(`Alpha${stamp}`);

  await items.nth(1).getByRole("button", { name: "Move up" }).click();
  await expect(items.nth(0)).toContainText(`Beta${stamp}`);

  await items.nth(2).getByRole("button", { name: "Drop" }).click();
  await expect(items).toHaveCount(2);

  await items.nth(0).getByRole("button", { name: "Start this part" }).click();
  await expect(page).toHaveURL(/\/videos\/[0-9a-f-]{36}/);

  await page.goBack();
  await page.goto("/series");
  await expect(page.getByRole("link", { name: title })).toBeVisible();
  await page.getByRole("link", { name: title }).click();
  const started = page.getByRole("listitem").filter({ hasText: `Beta${stamp}` });
  await expect(started.getByText("Started, short")).toBeVisible();
  await expect(started.getByRole("link", { name: "Open the video" })).toBeVisible();
  await expect(started.getByRole("button", { name: "Start this part" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("Series: a short title is refused with a plain sentence", async ({ page }) => {
  await page.goto("/series/new");
  await page.getByLabel("Title").fill("ab");
  await page.getByLabel("Title").evaluate((el) => el.removeAttribute("minlength"));
  await page.getByRole("button", { name: "Create series" }).click();
  await expect(page.getByText("Give the series a title of 3 to 80 characters.")).toBeVisible();
});
