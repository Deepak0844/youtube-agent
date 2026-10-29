import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { endSessionPool, mintSession, revokeSession } from "../fixtures/sessions";

// Runs with the seeded owner's session. Budgets are shared across specs, so every test sets the cap it needs first and puts
// the seeded default back at the end.
const SCOPE = "video:ai";
const DEFAULT = 15_000_000;
let db: pg.Pool;
test.beforeAll(() => {
  db = new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 2 });
});
test.afterAll(async () => {
  await db.end();
  await endSessionPool();
});
const setCap = (cap: number | null) => db.query("update budgets set cap_micro_usd = $2 where scope = $1", [SCOPE, cap]);
const capInDb = async () => (await db.query("select cap_micro_usd as c from budgets where scope = $1", [SCOPE])).rows[0].c as string | null;
test.beforeEach(() => setCap(DEFAULT));
test.afterEach(() => setCap(DEFAULT));

const row = (page: Page) => page.locator(`li[data-scope="${SCOPE}"]`);
async function open(page: Page) {
  await page.goto("/settings/budgets");
  await page.waitForLoadState("networkidle"); // client components: act only after hydration
  await expect(page.getByRole("heading", { level: 1, name: "Budgets" })).toBeVisible();
}

test("a visitor without a session sees no budget content", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  try {
    await page.goto("/settings/budgets");
    await page.waitForURL(/\/login/);
    await expect(page.getByText("Spending so far")).toHaveCount(0);
    await expect(page.getByText("AI video")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("a session that ends before Save is refused and the cap does not change", async ({ browser, baseURL }) => {
  const token = await mintSession();
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  await context.addCookies([{ name: "ytstudio_session", value: token, url: baseURL! }]);
  const page = await context.newPage();
  try {
    await open(page);
    await row(page).getByRole("button", { name: "Edit AI video limit" }).click();
    await row(page).getByLabel("Limit in dollars").fill("99");
    await revokeSession(token);
    await row(page).getByRole("button", { name: "Save limit" }).click();
    await page.waitForURL(/\/login/);
    expect(await capInDb()).toBe(String(DEFAULT));
  } finally {
    await context.close();
  }
});

test("edit a cap: it shows in dollars and an audit row appears", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId(`cap-${SCOPE}`)).toHaveText("$15.00");
  await row(page).getByRole("button", { name: "Edit AI video limit" }).click();
  await row(page).getByLabel("Limit in dollars").fill("20.5");
  await row(page).getByRole("button", { name: "Save limit" }).click();
  await expect(page.getByTestId(`cap-${SCOPE}`)).toHaveText("$20.50");
  expect(await capInDb()).toBe("20500000");
  await expect(page.getByTestId("budget-audit-row").first()).toContainText("AI video: $15.00 to $20.50");
  const audit = await db.query("select detail from audit_log where event = 'budget.cap_changed' order by id desc limit 1");
  expect(audit.rows[0].detail).toMatchObject({ scope: SCOPE, oldCapMicroUsd: DEFAULT, newCapMicroUsd: 20_500_000 });
});

test("a bad figure is refused with a sentence and nothing changes", async ({ page }) => {
  await open(page);
  await row(page).getByRole("button", { name: "Edit AI video limit" }).click();
  await row(page).getByLabel("Limit in dollars").fill("-3");
  await row(page).getByRole("button", { name: "Save limit" }).click();
  await expect(row(page).getByRole("status")).toContainText("Nothing was saved");
  expect(await capInDb()).toBe(String(DEFAULT));
});

test("No limit asks first, then shows 'no limit' (never $0), and a cap of 0 shows $0.00", async ({ page }) => {
  await open(page);
  await row(page).getByRole("button", { name: "Edit AI video limit" }).click();
  await row(page).getByRole("switch", { name: "No limit for AI video" }).click();
  await row(page).getByRole("button", { name: "Save limit" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Nothing will stop spending on this kind of video");
  expect(await capInDb()).toBe(String(DEFAULT)); // asking is not saving
  await dialog.getByRole("button", { name: "Keep a limit" }).click();
  expect(await capInDb()).toBe(String(DEFAULT));

  await row(page).getByRole("button", { name: "Save limit" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove limit" }).click();
  await expect(page.getByTestId(`cap-${SCOPE}`)).toHaveText("no limit");
  await expect(page.getByTestId(`cap-${SCOPE}`)).not.toContainText("$");
  expect(await capInDb()).toBeNull();

  await row(page).getByRole("button", { name: "Edit AI video limit" }).click();
  await row(page).getByRole("switch", { name: "No limit for AI video" }).click();
  await row(page).getByLabel("Limit in dollars").fill("0");
  await row(page).getByRole("button", { name: "Save limit" }).click();
  await expect(page.getByTestId(`cap-${SCOPE}`)).toHaveText("$0.00");
  expect(await capInDb()).toBe("0");
  await expect(page.getByTestId("budget-audit-row").first()).toContainText("AI video: no limit to $0.00");
});

test("the Budgets page is in the nav and fits the screen", async ({ page }) => {
  await open(page);
  const phone = (page.viewportSize()?.width ?? 1440) < 768;
  if (!phone) await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Budgets" })).toHaveAttribute("aria-current", "page");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});
