import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { makeKeyring } from "@/server/core/vault-crypto";
import { putSecret } from "@/server/db/vault";
import { endSessionPool, expireSession, mintSession, revokeSession } from "../fixtures/sessions";

// Failure artifacts (trace, screenshot, video) record what fill() types: only throwaway strings here, never a real key.
const KEY = "sk-ant-api03-UI-SPEC-KEY-NEVER-SHOWN-9z8y7x6w5v";
const KEY2 = "sk-ant-api03-UI-SPEC-SECOND-NEVER-SHOWN-1q2w3e4r";
const phone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 768;

let db: pg.Pool;
test.beforeAll(() => {
  db = new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 2 });
});
test.afterAll(async () => {
  await db.end();
  await endSessionPool();
});

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

  // Test button: this sends the fake key to the real api.anthropic.com, so it is skipped in CI (no outside network from tests
  // there). The unit and integration tests cover the Test button's behaviour with a fake provider.
  if (!process.env.CI) {
    await a.getByRole("button", { name: "Test Anthropic key" }).click();
    await expect(a.getByTestId("test-status-anthropic")).toContainText(/Works|Rejected by provider|Could not reach/, { timeout: 20_000 });
  }

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
  expect(events).toEqual(expect.arrayContaining(process.env.CI ? ["key.set", "key.removed"] : ["key.set", "key.tested", "key.removed"]));
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

// The guard is proven from a real browser, so Playwright sends the genuine Server Action encoding: seed a real key, open the
// page with a live session, END the session in the database, then press the button. The action must refuse (back to /login)
// and leave the stored key and the audit log exactly as they were. Deleting `await requireOwner()` from an action turns this red.
const snapshot = async () => ({
  secrets: (await db.query("select name, hint, encode(ciphertext, 'hex') c from secrets order by name")).rows,
  audits: (await db.query("select count(*)::int n from audit_log where event in ('key.set', 'key.removed', 'key.tested')")).rows[0].n as number,
});
const END = { "a revoked session": revokeSession, "an expired session": expireSession } as const;
const ACTIONS = ["save", "test", "remove"] as const;

for (const [label, end] of Object.entries(END)) {
  for (const action of ACTIONS) {
    test(`${action} after ${label} is refused and changes nothing`, async ({ browser, baseURL }) => {
      await db.query("delete from secrets where name like 'provider.%'");
      await putSecret(db, makeKeyring(process.env.E2E_VAULT_MASTER_KEY!), "provider.openai.api_key", "sk-proj-SEEDED-STAYS-PUT-0z9y8x7w6v5u");
      const token = await mintSession();
      const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
      await context.addCookies([{ name: "ytstudio_session", value: token, url: baseURL! }]);
      const page = await context.newPage();
      try {
        await page.goto("/settings/keys");
        await page.waitForLoadState("networkidle");
        const r = row(page, "OpenAI");
        await expect(r.getByText("Saved", { exact: true })).toBeVisible();
        if (action === "save") {
          await r.getByRole("button", { name: "Replace OpenAI key" }).click();
          await r.getByLabel("New OpenAI key").fill("sk-proj-SHOULD-NOT-BE-SAVED-1234567890abcdef");
        }
        const before = await snapshot();
        await end(token);
        if (action === "save") await r.getByRole("button", { name: "Replace key" }).click();
        else if (action === "test") await r.getByRole("button", { name: "Test OpenAI key" }).click();
        else {
          await r.getByRole("button", { name: "Remove OpenAI key" }).click();
          await page.getByRole("alertdialog").getByRole("button", { name: "Remove key" }).click();
        }
        await page.waitForURL(/\/login/);
        expect(await snapshot()).toEqual(before);
      } finally {
        await context.close();
        await db.query("delete from secrets where name like 'provider.%'");
      }
    });
  }
}
