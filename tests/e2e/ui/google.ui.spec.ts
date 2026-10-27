import { readFileSync } from "node:fs";
import pg from "pg";
import { expect, test, type Page } from "@playwright/test";

const phone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 768;

test("page shows the redirect address, setup guide and an empty state", async ({ page }) => {
  await page.goto("/settings/google");
  await expect(page.getByRole("heading", { level: 1, name: "Google app" })).toBeVisible();
  await expect(page.getByTestId("redirect-uri")).toHaveText("http://localhost:3000/api/oauth/google/callback");
  await expect(page.getByRole("button", { name: "Copy redirect address" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Setting it up in Google" })).toBeVisible();
  await expect(page.getByText("Nothing is sent to Google")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByRole("link", { name: "Google app" }).first()).toBeAttached();
});

test("a wrong client id is refused in words and nothing is saved", async ({ page }) => {
  await page.goto("/settings/google");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Client ID").fill("not-a-google-id");
  await page.getByLabel("Client secret").fill("GOCSPX-badidattempt0000000000000000");
  await page.getByRole("button", { name: "Save to vault" }).click();
  await expect(page.getByText("does not look like a Google client ID")).toBeVisible();
});

test("save, replace and check: the secret never comes back in a page, response, log or audit row", async ({ page }, info) => {
  const tag = info.project.name.replace(/\W/g, "");
  const SECRET = `GOCSPX-E2eSecretValue${tag}Zq9xK2mP7`;
  const ID = `424242424242-e2eclientid${tag.toLowerCase()}abcdefgh.apps.googleusercontent.com`;
  const bodies: string[] = [];
  page.on("response", async (r) => {
    try {
      bodies.push(await r.text());
    } catch {
      /* redirects and streamed bodies */
    }
  });
  await page.goto("/settings/google");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Client ID").fill(ID);
  await page.getByLabel("Client secret").fill(SECRET);
  await page.getByRole("button", { name: "Save to vault" }).click();
  await expect(page.getByText("Saved. The secret is in the vault")).toBeVisible();
  await expect(page.getByLabel("Client secret")).toHaveValue("");
  await expect(page.getByText("Stored secret:")).toBeVisible();

  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("Stored: 4242….apps.googleusercontent.com")).toBeVisible();
  expect(await page.content()).not.toContain(SECRET);
  expect(await page.content()).not.toContain(ID); // only the masked id is rendered

  // replace with a second secret, then check format
  const SECRET2 = `GOCSPX-E2eSecondValue${tag}Lw4tR8nB5`;
  await page.getByLabel("Client secret").fill(SECRET2);
  await page.getByRole("button", { name: "Save to vault" }).click();
  await expect(page.getByText("Saved. The secret is in the vault")).toBeVisible();
  await page.getByRole("button", { name: "Check format" }).click();
  const result = page.getByTestId("format-result");
  await expect(result.getByText("Looks right")).toHaveCount(3);

  // the page itself, every response body seen, the server log and the database never hold either secret
  expect(await page.content()).not.toContain("E2eSecondValue");
  for (const b of bodies) for (const s of [SECRET, SECRET2]) expect(b).not.toContain(s);
  const log = readFileSync(process.env.E2E_SERVER_LOG!, "utf8");
  for (const s of [SECRET, SECRET2]) expect(log).not.toContain(s);
  const db = new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 1 });
  try {
    const audit = await db.query("select event, detail from audit_log where event like 'google_app.%' order by id");
    expect(audit.rows.map((r) => r.event)).toEqual(expect.arrayContaining(["google_app.saved", "google_app.tested"]));
    const dump = JSON.stringify(audit.rows) + JSON.stringify((await db.query("select * from google_apps")).rows) + JSON.stringify((await db.query("select name, hint from secrets")).rows);
    for (const s of [SECRET, SECRET2, "E2eSecretValue", "E2eSecondValue"]) expect(dump).not.toContain(s);
    const ct = (await db.query("select ciphertext from secrets where name = 'google.app.client_secret'")).rows[0].ciphertext as Buffer;
    expect(ct.includes(Buffer.from(SECRET2))).toBe(false);
  } finally {
    await db.end();
  }
});

test("phone: single column, 44 px targets, no horizontal scroll", async ({ page }) => {
  test.skip(!phone(page), "phone only");
  await page.goto("/settings/google");
  await page.waitForLoadState("networkidle");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const loc of [page.getByLabel("Client ID"), page.getByLabel("Client secret"), page.getByRole("button", { name: "Save to vault" }), page.getByRole("button", { name: "Copy redirect address" })]) {
    expect((await loc.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  const uri = (await page.getByTestId("redirect-uri").boundingBox())!;
  expect(uri.x + uri.width).toBeLessThanOrEqual(390);
});

test("desktop: credentials and redirect address sit side by side", async ({ page }) => {
  test.skip(phone(page), "desktop only");
  await page.goto("/settings/google");
  const a = (await page.getByRole("heading", { name: "Credentials" }).boundingBox())!;
  const b = (await page.getByRole("heading", { name: "Redirect address" }).boundingBox())!;
  expect(b.x).toBeGreaterThan(a.x + 200);
});

test("keyboard: fields are reachable in order", async ({ page }) => {
  test.skip(phone(page), "desktop only");
  await page.goto("/settings/google");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Client ID").focus();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Client secret")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Save to vault" })).toBeFocused();
});
