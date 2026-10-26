import { expect, test, type Page } from "@playwright/test";
import pg from "pg";

const KEY = "sk-ant-api03-UI-SPEC-KEY-NEVER-SHOWN-9z8y7x6w5v";
const KEY2 = "sk-ant-api03-UI-SPEC-SECOND-NEVER-SHOWN-1q2w3e4r";
const phone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 768;

let db: pg.Pool;
test.beforeAll(() => {
  db = new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 2 });
});
test.afterAll(() => db.end());

const row = (page: Page, label: string) => page.locator("li[data-provider]", { has: page.getByRole("heading", { name: label }) });

test("add, replace, test and remove a key; the key is never echoed back anywhere", async ({ page }) => {
  const bodies: string[] = [];
  page.on("response", async (r) => {
    if (r.url().startsWith("http://127.0.0.1")) bodies.push(await r.text().catch(() => ""));
  });
  await page.goto("/settings/keys");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { level: 1, name: "Keys" })).toBeVisible();
  await expect(page.getByTestId("vault-banner")).toHaveCount(0);
  for (const l of ["Anthropic", "OpenAI", "Gemini", "DeepSeek", "OpenRouter", "ElevenLabs", "Pexels", "Pixabay"]) await expect(row(page, l)).toBeVisible();

  const a = row(page, "Anthropic");
  await expect(a.getByText("Not set")).toBeVisible();
  // garbage first: refused with a fixed sentence
  await a.getByLabel("Anthropic API key").fill("hello");
  await a.getByRole("button", { name: "Save key" }).click();
  await expect(a.getByRole("status")).toContainText("does not look like a valid Anthropic key");
  // real shape
  await a.getByLabel("Anthropic API key").fill(KEY);
  await a.getByRole("button", { name: "Save key" }).click();
  await expect(a.getByText("Saved", { exact: true })).toBeVisible();
  await expect(a.getByText(`•••• ${KEY.slice(-4)}`)).toBeVisible();
  await expect(a.locator("input[name=value]")).toHaveCount(0);

  // test: a fake key against the real host gives a verdict (rejected, or could not reach when offline), never a crash
  await a.getByRole("button", { name: "Test Anthropic key" }).click();
  await expect(a.getByTestId("test-status-anthropic")).toContainText(/Works|Rejected by provider|Could not reach/, { timeout: 20_000 });

  // replace
  await a.getByRole("button", { name: "Replace Anthropic key" }).click();
  await a.getByLabel("New Anthropic key").fill(KEY2);
  await a.getByRole("button", { name: "Replace key" }).click();
  await expect(a.getByText(`•••• ${KEY2.slice(-4)}`)).toBeVisible();

  // remove asks first
  await a.getByRole("button", { name: "Remove Anthropic key" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Remove the Anthropic key?");
  await dialog.getByRole("button", { name: "Keep key" }).click();
  await expect(a.getByText("Saved", { exact: true })).toBeVisible();
  await a.getByRole("button", { name: "Remove Anthropic key" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove key" }).click();
  await expect(a.getByText("Not set")).toBeVisible();

  // nothing ever carried either key: not the DOM, not any response, not the audit log or the secrets table
  const html = await page.content();
  for (const k of [KEY, KEY2]) {
    expect(html).not.toContain(k);
    expect(bodies.join("\n")).not.toContain(k);
  }
  const dump = JSON.stringify([(await db.query("select t::text s from audit_log t")).rows, (await db.query("select t::text s from secrets t")).rows]);
  expect(dump).not.toContain("NEVER-SHOWN");
  const events = (await db.query("select event from audit_log where event like 'key.%' order by id")).rows.map((r) => r.event);
  expect(events).toEqual(expect.arrayContaining(["key.set", "key.tested", "key.removed"]));
});

test("layout and targets", async ({ page }) => {
  await page.goto("/settings/keys");
  await page.waitForLoadState("networkidle");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const r = row(page, "OpenAI");
  const input = r.getByLabel("OpenAI API key");
  const save = r.getByRole("button", { name: "Save key" });
  const min = phone(page) ? 44 : 36;
  for (const el of [input, save]) expect((await el.boundingBox())!.height).toBeGreaterThanOrEqual(min);
  // focus order inside a row: input then its save button
  await input.focus();
  await page.keyboard.press("Tab");
  await expect(save).toBeFocused();
});
