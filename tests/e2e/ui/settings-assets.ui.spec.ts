import { expect, test } from "@playwright/test";
import pg from "pg";
import { endSessionPool } from "../fixtures/sessions";

// Runs with the seeded owner's session. The settings are shared, so each test puts the defaults back.
let db: pg.Pool;
test.beforeAll(() => {
  db = new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 2 });
});
test.afterAll(async () => {
  await db.end();
  await endSessionPool();
});
const reset = () => db.query("update settings set value = '7' where key in ('assets.retention_days', 'assets.trash_days')");
test.beforeEach(reset);
test.afterEach(reset);

async function open(page: import("@playwright/test").Page) {
  await page.goto("/settings/assets");
  await page.waitForLoadState("networkidle"); // client components: act only after hydration
  await expect(page.getByRole("heading", { level: 1, name: "Asset settings" })).toBeVisible();
}

test("a visitor without a session sees no asset settings", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  try {
    await page.goto("/settings/assets");
    await page.waitForURL(/\/login/);
    await expect(page.getByText("Clean-up and upload limits")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("shows the defaults and the note that clean-up arrives with publishing", async ({ page }) => {
  await open(page);
  await expect(page.getByLabel("Days to keep uploads after a video is finished")).toHaveValue("7");
  await expect(page.getByLabel("Days to keep an upload no video uses")).toHaveValue("30");
  await expect(page.getByLabel("Biggest photo (MB)")).toHaveValue("25");
  await expect(page.getByRole("note")).toContainText("arrives with publishing");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("saves a new window and writes an audit row; an out-of-range value saves nothing", async ({ page }) => {
  await open(page);
  const days = page.getByLabel("Days to keep uploads after a video is finished");
  await days.fill("14");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  const stored = async () => (await db.query("select value from settings where key = 'assets.retention_days'")).rows[0].value;
  expect(await stored()).toBe(14);
  const audit = await db.query("select count(*)::int as n from audit_log where event = 'setting.changed' and detail->>'setting' = 'assets.retention_days'");
  expect(audit.rows[0].n).toBeGreaterThan(0);
  // the browser blocks 61 (max=60); post it straight to prove the server refuses it too
  await days.evaluate((el) => el.removeAttribute("max"));
  await days.fill("61");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Check the numbers")).toBeVisible();
  expect(await stored()).toBe(14);
});
