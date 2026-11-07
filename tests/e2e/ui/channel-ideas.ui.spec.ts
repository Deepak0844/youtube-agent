import pg from "pg";
import { expect, test } from "@playwright/test";

// Shows the per-channel controls only. Nothing here clicks "Research now" or "Refresh description": both would call a paid model
// or YouTube. A throwaway connected channel row is added for the page and removed after.
const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const CHANNEL = `UCe2e${stamp}`.slice(0, 40);
const TITLE = `E2E channel ${stamp}`;
let db: pg.Pool;

test.beforeAll(async () => {
  db = new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 2 });
  const a = await db.query<{ id: string }>("insert into google_accounts (google_sub, email) values ($1, $2) returning id", [`e2e-sub-${stamp}`, `e2e-${stamp}@example.com`]);
  await db.query("insert into youtube_channels (google_account_id, channel_id, title, token_secret_name, status) values ($1, $2, $3, $4, 'connected')", [a.rows[0]!.id, CHANNEL, TITLE, `e2e-tok-${stamp}`]);
});
test.afterAll(async () => {
  await db.query("update ideas set channel_id = null where channel_id = $1", [CHANNEL]);
  await db.query("delete from youtube_channels where channel_id = $1", [CHANNEL]);
  await db.query("delete from google_accounts where google_sub = $1", [`e2e-sub-${stamp}`]);
  await db.end();
});

test("Ideas: Research now has a channel select and the add form and filter list the channel", async ({ page }) => {
  await page.goto("/ideas");
  await expect(page.getByRole("heading", { name: "Ideas", level: 1 })).toBeVisible();
  const research = page.getByLabel("Channel", { exact: true });
  await expect(research).toBeVisible();
  await expect(research.locator("option", { hasText: "All channels" })).toHaveCount(1);
  await expect(research.locator("option", { hasText: TITLE })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Research now" })).toBeEnabled();
  await expect(page.getByLabel("Channel (optional)").locator("option", { hasText: TITLE })).toHaveCount(1);
  await expect(page.getByLabel("Show channel").locator("option", { hasText: TITLE })).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("Ideas: a manual idea for a channel shows that channel and the filter keeps only it", async ({ page }) => {
  await page.goto("/ideas");
  const topic = `ca${stamp} cb${stamp} cc${stamp} cd${stamp}`;
  await page.getByLabel("Topic").fill(topic);
  await page.getByLabel("Channel (optional)").selectOption(CHANNEL);
  await page.getByRole("button", { name: "Add idea" }).click();
  const card = page.getByRole("listitem").filter({ hasText: `ca${stamp}` });
  await expect(card.getByText(`Channel: ${TITLE}`)).toBeVisible();
  await page.goto(`/ideas?channel=${CHANNEL}`);
  await expect(page.getByRole("listitem").filter({ hasText: `ca${stamp}` })).toBeVisible();
  await page.goto("/ideas?channel=none");
  await expect(page.getByRole("listitem").filter({ hasText: `ca${stamp}` })).toHaveCount(0);
});

test("Channels: a connected channel has a Refresh description button", async ({ page }) => {
  await page.goto("/settings/channels");
  await expect(page.getByRole("heading", { name: "YouTube channels", level: 1 })).toBeVisible();
  const row = page.getByRole("listitem").filter({ hasText: TITLE });
  await expect(row.getByRole("button", { name: "Refresh description" })).toBeEnabled();
  await expect(row.getByText("Reads this channel's description from YouTube")).toBeVisible();
});
