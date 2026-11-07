import { expect, test } from "@playwright/test";

// Runs with the seeded owner's session. Draft now starts a normal video that waits at its first step; nothing is approved or uploaded.
test("Ideas: add, refuse a near-duplicate, dismiss, draft now", async ({ page }) => {
  // Words carry the run stamp so the desktop and phone runs never look like duplicates of each other.
  const stamp = Date.now().toString(36);
  const zebra0 = `za${stamp} zb${stamp} zc${stamp} zd${stamp}`;
  await page.goto("/ideas");
  await expect(page.getByRole("heading", { name: "Ideas", level: 1 })).toBeVisible();

  await page.getByLabel("Topic").fill(zebra0);
  await page.getByLabel("Hook (optional)").fill(`Hook ${stamp}`);
  await page.getByLabel(/Sources/).fill(`https://example.com/${stamp}`);
  await page.getByRole("button", { name: "Add idea" }).click();
  await expect(page.getByText(`Hook ${stamp}`)).toBeVisible();
  await expect(page.getByText(`https://example.com/${stamp}`)).toBeVisible();

  await page.getByLabel("Topic").fill(`${zebra0} again`);
  await page.getByRole("button", { name: "Add idea" }).click();
  await expect(page.getByText("Too like a topic you already have")).toBeVisible();

  await page.getByLabel("Topic").fill(`wa${stamp} wb${stamp} wc${stamp} wd${stamp}`);
  await page.getByRole("button", { name: "Add idea" }).click();
  const walrus = page.getByRole("listitem").filter({ hasText: `wa${stamp}` });
  await expect(walrus).toBeVisible();
  await walrus.getByRole("button", { name: "Dismiss" }).click();
  await expect(walrus).toHaveCount(0);

  const zebra = page.getByRole("listitem").filter({ hasText: `za${stamp}` });
  await zebra.getByRole("button", { name: "Draft now" }).click();
  await expect(page).toHaveURL(/\/videos\/[0-9a-f-]{36}/);
  await page.goto("/ideas");
  await expect(page.getByRole("listitem").filter({ hasText: `za${stamp}` }).getByText("Drafted: open the video")).toBeVisible();
});
