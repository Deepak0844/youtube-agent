import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { endSessionPool } from "../fixtures/sessions";

// Runs with the seeded owner's session. Providers and routes are shared state, so each test starts and ends with everything off and no routes.
let db: pg.Pool;
test.beforeAll(() => {
  db = new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 2 });
});
test.afterAll(async () => {
  await db.end();
  await endSessionPool();
});
const reset = async () => {
  await db.query("update media_providers set enabled = false");
  await db.query("delete from media_routes");
};
test.beforeEach(reset);
test.afterEach(reset);

const row = (page: Page, id: string) => page.locator(`li[data-provider="${id}"]`);
async function open(page: Page) {
  await page.goto("/settings/providers");
  await page.waitForLoadState("networkidle"); // client components: act only after hydration
  await expect(page.getByRole("heading", { level: 1, name: "Providers" })).toBeVisible();
}

test("a visitor without a session sees no provider content", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  try {
    await page.goto("/settings/providers");
    await page.waitForURL(/\/login/);
    await expect(page.getByText("Who is used for what")).toHaveCount(0);
    await expect(page.getByText("Edge voices")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("prices: free shows 'free', an unset price says so, nothing is invented", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("price-edge")).toHaveText("free");
  await expect(page.getByTestId("price-elevenlabs")).toHaveText("about $0.048"); // 600 chars at $0.08 per 1,000 (migration 0031)
  await expect(page.getByTestId("price-google_tts")).toHaveText("price not set");
  await expect(row(page, "google_tts").getByRole("link", { name: "Key needed" })).toBeVisible();
});

test("a paid provider cannot be switched on without its key", async ({ page }) => {
  await open(page);
  await row(page, "google_tts").getByRole("switch").click();
  await expect(row(page, "google_tts").getByRole("status")).toContainText("Save its key on the Keys page first");
  expect((await db.query("select enabled from media_providers where id = 'google_tts'")).rows[0].enabled).toBe(false);
});

test("set the default voice for shorts and for code-scene videos", async ({ page }) => {
  await open(page);
  await row(page, "edge").getByRole("switch").click();
  await expect(row(page, "edge").getByText("On", { exact: true })).toBeVisible();

  for (const [scope, voice] of [["Shorts", "en-US-AriaNeural"], ["Code-scene videos", "en-GB-SoniaNeural"]]) {
    await page.getByLabel("Provider", { exact: true }).selectOption({ label: "Edge voices (voice)" });
    await page.getByLabel("Used for", { exact: true }).selectOption({ label: scope! });
    await page.getByLabel(/Narration voice/).fill(voice!);
    await page.getByRole("button", { name: "Use for this" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  }
  const table = page.getByTestId("route-table");
  await expect(table.getByRole("row", { name: /Shorts.*Edge voices.*en-US-AriaNeural/ })).toBeVisible();
  await expect(table.getByRole("row", { name: /Code-scene videos.*Edge voices.*en-GB-SoniaNeural/ })).toBeVisible();
  const routes = await db.query("select scope, provider, voice from media_routes order by scope");
  expect(routes.rows).toEqual([
    { scope: "format:short", provider: "edge", voice: "en-US-AriaNeural" },
    { scope: "kind:tsx", provider: "edge", voice: "en-GB-SoniaNeural" },
  ]);
  const audit = await db.query("select count(*)::int as n from audit_log where event in ('route.changed', 'provider.toggled') and at > now() - interval '1 minute'");
  expect(audit.rows[0].n).toBeGreaterThanOrEqual(3);
});

test("the Providers page is in the nav and fits the screen", async ({ page }) => {
  await open(page);
  const phone = (page.viewportSize()?.width ?? 1440) < 768;
  if (!phone) await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Providers" })).toHaveAttribute("aria-current", "page");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});
