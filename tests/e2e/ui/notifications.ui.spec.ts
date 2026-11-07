import { expect, test, type Page } from "@playwright/test";
import pg from "pg";

// Runs with the seeded owner's session. Settings persist across the desktop and phone runs, so each test restores what it changes.
// notification_log is append-only: the banner test ends with a good "sent" row so later runs start without a banner.
let db: pg.Pool;
test.beforeAll(() => {
  db = new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 2 });
});
test.afterAll(async () => {
  await db.end();
});

const open = async (page: Page) => {
  await page.goto("/settings/notifications");
  await expect(page.getByRole("heading", { level: 1, name: "Notifications" })).toBeVisible();
};
const noPageScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

test("quiet hours, a switch and the master switch save and survive a reload", async ({ page }) => {
  await open(page);
  const start = page.getByLabel("From");
  const old = await start.inputValue();
  const popup = page.getByLabel("Video failed: popup");
  const was = await popup.isChecked();
  await start.fill("21:15");
  await page.getByLabel("Hold messages during quiet hours").check();
  if (was) await popup.uncheck(); else await popup.check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("From")).toHaveValue("21:15");
  await expect(page.getByLabel("Hold messages during quiet hours")).toBeChecked();
  expect(await page.getByLabel("Video failed: popup").isChecked()).toBe(!was);
  await expect(page.getByLabel("Video failed: bell")).toBeDisabled();
  await noPageScroll(page);
  // restore
  await page.getByLabel("From").fill(old);
  await page.getByLabel("Hold messages during quiet hours").uncheck();
  if (was) await page.getByLabel("Video failed: popup").check(); else await page.getByLabel("Video failed: popup").uncheck();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
});

test("a private or loopback webhook address is refused: on Test and on Save", async ({ page }) => {
  await open(page);
  const field = page.getByLabel("Webhook address");
  await field.fill("http://127.0.0.1:9/hook");
  await page.getByRole("button", { name: "Send test message" }).click();
  await expect(page.getByTestId("webhook-test-result")).toContainText("not allowed");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "not allowed" })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Webhook address")).toHaveValue("");
});

test("a failing channel shows the banner, and a later good send clears it", async ({ page }) => {
  const transition = `ui-${Date.now()}-${test.info().project.name}`;
  const { rows } = await db.query<{ id: string }>(
    "insert into notifications (event, to_state, transition_id, title, text) values ('run_failed', 'run_failed', $1, 'Research or scheduler run failed', 'ui test') returning id",
    [transition],
  );
  await db.query("insert into notification_log (notification_id, channel, status, error) values ($1, 'webhook', 'failed', 'Error')", [rows[0]!.id]);
  await open(page);
  await expect(page.getByTestId("delivery-banner")).toContainText("Webhook messages are failing");
  await db.query("insert into notification_log (notification_id, channel, status) values ($1, 'webhook', 'sent')", [rows[0]!.id]);
  await page.reload();
  await expect(page.getByTestId("delivery-banner")).toHaveCount(0);
});

test("the bell shows the unread count and the message, and Mark all read clears it", async ({ page }) => {
  const transition = `bell-${Date.now()}-${test.info().project.name}`;
  await db.query("insert into notifications (event, to_state, transition_id, title, text) values ('video_failed', 'failed', $1, 'Video failed', $1)", [transition]);
  await page.goto("/");
  const bell = page.getByTestId("bell");
  await expect(bell.getByTestId("bell-count")).toBeVisible();
  await bell.locator("summary").click();
  await expect(bell.getByTestId("bell-item").filter({ hasText: transition })).toBeVisible();
  await bell.getByRole("button", { name: "Mark all read" }).click();
  await expect(page.getByTestId("bell").getByTestId("bell-count")).toHaveCount(0);
});
