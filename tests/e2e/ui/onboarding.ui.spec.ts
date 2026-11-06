import pg from "pg";
import { expect, test } from "@playwright/test";

// The e2e database is shared (one worker), so this seeds one fake key row and removes it again. The wizard only reads names.
const NAME = "provider.groq.api_key";
let db: pg.Pool;
test.beforeAll(() => {
  db = new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 2 });
});
test.afterAll(async () => {
  await db.end();
});
test.afterEach(async () => {
  await db.query("delete from secrets where name = $1", [NAME]);
});

test("wizard shows five steps from real state and links to the existing pages", async ({ page }) => {
  await page.goto("/onboarding");
  await expect(page.getByRole("heading", { level: 1, name: "Set up" })).toBeVisible();
  for (const id of ["keys", "models", "google", "channel", "dryrun"]) await expect(page.getByTestId(`step-${id}`)).toBeVisible();
  await expect(page.getByTestId("step-keys").getByText("Not done")).toBeVisible();
  await expect(page.getByTestId("step-dryrun")).toContainText("no paid calls, no uploads, nothing published");
  await expect(page.getByTestId("step-google").getByRole("link")).toHaveAttribute("href", "/settings/google");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("a saved key marks the keys step done", async ({ page }) => {
  await db.query(
    "insert into secrets (name, ciphertext, nonce, key_id, hint) values ($1, decode(repeat('00', 20), 'hex'), decode(repeat('00', 12), 'hex'), 'deadbeef', 'abcd') on conflict (name) do nothing",
    [NAME],
  );
  await page.goto("/onboarding");
  await expect(page.getByTestId("step-keys").getByText("Done", { exact: true })).toBeVisible();
  await expect(page.getByTestId("step-keys").getByRole("link", { name: "Review keys" })).toBeVisible();
});

test("home links to setup while steps are open", async ({ page }) => {
  await page.goto("/");
  const link = page.getByTestId("first-run").getByRole("link", { name: "Continue setup" });
  await expect(link).toHaveAttribute("href", "/onboarding");
});
