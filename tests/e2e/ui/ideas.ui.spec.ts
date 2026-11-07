import { expect, test } from "@playwright/test";

// Runs with the seeded owner's session. Draft now starts a normal video that waits at its first step; nothing is approved or uploaded.
test("Ideas: add, refuse a near-duplicate, dismiss, draft now", async ({ page }) => {
  const stamp = Date.now().toString(36);
  await page.goto("/ideas");
  await expect(page.getByRole("heading", { name: "Ideas", level: 1 })).toBeVisible();

  await page.getByLabel("Topic").fill(`Zebrafish ${stamp} gene scissors explained`);
  await page.getByLabel("Hook (optional)").fill("Cut DNA like paper");
  await page.getByLabel(/Sources/).fill("https://example.com/crispr");
  await page.getByRole("button", { name: "Add idea" }).click();
  await expect(page.getByText("Cut DNA like paper")).toBeVisible();
  await expect(page.getByText("https://example.com/crispr")).toBeVisible();

  await page.getByLabel("Topic").fill(`Zebrafish ${stamp} gene scissors explained again`);
  await page.getByRole("button", { name: "Add idea" }).click();
  await expect(page.getByText("Too like a topic you already have")).toBeVisible();

  await page.getByLabel("Topic").fill(`Walrus ${stamp} tusk growth secrets`);
  await page.getByRole("button", { name: "Add idea" }).click();
  const walrus = page.getByRole("listitem").filter({ hasText: `Walrus ${stamp}` });
  await expect(walrus).toBeVisible();
  await walrus.getByRole("button", { name: "Dismiss" }).click();
  await expect(walrus).toHaveCount(0);

  const zebra = page.getByRole("listitem").filter({ hasText: `Zebrafish ${stamp}` });
  await zebra.getByRole("button", { name: "Draft now" }).click();
  await expect(page).toHaveURL(/\/videos\/[0-9a-f-]{36}/);
  await page.goto("/ideas");
  await expect(page.getByRole("listitem").filter({ hasText: `Zebrafish ${stamp}` }).getByText("Drafted: open the video")).toBeVisible();
});
