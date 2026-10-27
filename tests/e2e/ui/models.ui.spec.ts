import { expect, test, type Page } from "@playwright/test";

const phone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 768;
const uid = () => Math.random().toString(36).slice(2, 8);

async function openAdd(page: Page) {
  await page.getByText("Add a model", { exact: true }).click();
  return page.getByRole("form", { name: "Add a model" });
}

test("page renders with no horizontal scroll", async ({ page }) => {
  await page.goto("/settings/models");
  await expect(page.getByRole("heading", { level: 1, name: "Models" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Stage routing" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("an unpriced model cannot be enabled; a priced one can, then it is routed", async ({ page }) => {
  const id = uid();
  await page.goto("/settings/models");
  await page.waitForLoadState("networkidle");
  const form = await openAdd(page);
  await form.getByLabel("Model id").fill(`m-${id}`);
  await form.getByLabel("Name in this app").fill(`Paid ${id}`);
  await form.getByLabel("Enabled").check();
  await form.getByRole("button", { name: "Add model" }).click();
  await expect(form.getByRole("status")).toContainText("cannot be enabled");

  await form.getByLabel("Input", { exact: true }).fill("3.00");
  await form.getByLabel("Output", { exact: true }).fill("15.00");
  await form.getByRole("button", { name: "Add model" }).click();
  await expect(page.getByRole("heading", { name: `Paid ${id}` })).toBeVisible();
  await expect(page.getByText("$3.00 in / $15.00 out").first()).toBeVisible();

  const outline = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Outline", exact: true }) });
  await outline.getByRole("combobox").selectOption(`Paid ${id} (anthropic)`);
  await outline.getByRole("button", { name: "Use" }).click();
  await expect(outline.getByRole("status")).toHaveText("Saved.");
  await page.reload();
  await expect(outline.getByRole("combobox")).toContainText(`Paid ${id}`);
});

test("a hosted model cannot be free; a local one can", async ({ page }) => {
  const id = uid();
  await page.goto("/settings/models");
  await page.waitForLoadState("networkidle");
  const form = await openAdd(page);
  await form.getByLabel("Model id").fill(`h-${id}`);
  await form.getByLabel("Name in this app").fill(`Hosted ${id}`);
  await form.getByLabel("Free: runs on this machine").check();
  await form.getByRole("button", { name: "Add model" }).click();
  await expect(form.getByRole("status")).toContainText("Only a local endpoint");

  await form.locator("select[name=provider]").selectOption("ollama");
  await form.getByLabel("Model id").fill(`q-${id}`);
  await form.getByLabel("Name in this app").fill(`Local ${id}`);
  await form.locator("input[name=baseUrl]").fill("http://localhost:11434/v1");
  await form.getByRole("button", { name: "Add model" }).click();
  await expect(page.getByRole("heading", { name: `Local ${id}` })).toBeVisible();
  await expect(page.getByText("Free on this machine").first()).toBeVisible();
});

test("touch targets on phone are at least 44 px", async ({ page }) => {
  test.skip(!phone(page), "phone only");
  await page.goto("/settings/models");
  await page.waitForLoadState("networkidle");
  for (const b of await page.getByRole("button", { name: "Use" }).all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  for (const s of await page.getByRole("combobox").all()) expect((await s.boundingBox())!.height).toBeGreaterThanOrEqual(44);
});
