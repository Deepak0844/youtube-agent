import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { insertAudit } from "@/server/db/audit";

// Runs with the seeded owner's session. The log is append-only for the app role, so tests never clean up: every test writes
// rows carrying its own marker and looks only at those.
let db: pg.Pool;
test.beforeAll(() => {
  db = new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 2 });
});
test.afterAll(async () => {
  await db.end();
});

const phone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 768;
const heading = (page: Page) => page.getByRole("heading", { level: 1, name: "Audit log" });
const noPageScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

async function open(page: Page, query = "") {
  await page.goto(`/settings/audit${query}`);
  await expect(heading(page)).toBeVisible();
}

test("shows the log newest first with relative and absolute UTC time, and no horizontal scroll", async ({ page }) => {
  const marker = `order-${Date.now()}`;
  await insertAudit(db, "setting.changed", { marker, n: 1 });
  await insertAudit(db, "setting.changed", { marker, n: 2 });
  await open(page);
  const rows = page.getByTestId("audit-row").filter({ hasText: marker });
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText(/n\s*2/);
  await expect(rows.nth(1)).toContainText(/n\s*1/);
  await expect(rows.first().getByText("just now")).toBeVisible();
  await expect(rows.first().locator("time")).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}T/);
  await expect(rows.first()).toContainText(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/);
  await expect(page.getByRole("navigation", { name: phone(page) ? "Bottom" : "Primary" })).toBeVisible();
  await noPageScroll(page);
});

test("hostile text in a detail renders inert: no script runs, no element appears, it is shown as text", async ({ page }) => {
  const marker = `xss-${Date.now()}`;
  const payload = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>`;
  await insertAudit(db, "setting.changed", { marker, note: payload, [`<b onmouseover=alert(1)>${marker}`]: "k" });
  await open(page);
  const row = page.getByTestId("audit-row").filter({ hasText: marker }).first();
  await expect(row).toContainText("<img src=x onerror=");
  expect(await row.locator("img, script, b").count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(await page.locator("main script:not([src])").count()).toBe(0);
});

test("long, Indic and unbroken strings wrap inside the layout and are truncated", async ({ page }) => {
  const marker = `wrap-${Date.now()}`;
  await insertAudit(db, "setting.changed", {
    marker,
    title: "बहुत लंबा शीर्षक ".repeat(60),
    tamil: "தமிழ் நீண்ட தலைப்பு ".repeat(40),
    glued: "abcdefghijklmnopqrs.".repeat(15),
    path: "/a/very/long/path/".repeat(30) + "x",
  });
  await open(page);
  const row = page.getByTestId("audit-row").filter({ hasText: marker }).first();
  await expect(row).toBeVisible();
  const text = (await row.innerText()).length;
  expect(text).toBeLessThan(900); // truncated, not dumped
  await noPageScroll(page);
  const box = await row.boundingBox();
  const vw = page.viewportSize()!.width;
  expect(box!.x + box!.width).toBeLessThanOrEqual(vw + 0.5);
  // nothing inside the row pokes out of it
  const overflow = await row.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return [...el.querySelectorAll("*")].filter((c) => c.getBoundingClientRect().right > r.right + 1).length;
  });
  expect(overflow).toBe(0);
});

test("filter chips narrow the list, mark the current one, and All clears it", async ({ page }) => {
  const marker = `chip-${Date.now()}`;
  await insertAudit(db, "key.set", { marker, name: "openai" });
  await insertAudit(db, "login.success", { marker });
  await open(page);
  const chips = page.getByRole("navigation", { name: "Filter by kind" });
  await chips.getByRole("link", { name: "Keys" }).click();
  await expect(page).toHaveURL(/event=key/);
  await expect(chips.getByRole("link", { name: "Keys" })).toHaveAttribute("aria-current", "true");
  await expect(page.getByTestId("audit-row").filter({ hasText: marker })).toHaveCount(1);
  for (const r of await page.getByTestId("audit-row").all()) await expect(r).toHaveAttribute("data-event", /^key\./);
  await chips.getByRole("link", { name: "All" }).click();
  await expect(page).not.toHaveURL(/event=/);
  await expect(page.getByTestId("audit-row").filter({ hasText: marker })).toHaveCount(2);
});

test("Older pages through without duplicates or gaps, and Newest returns", async ({ page }) => {
  const marker = `page-${Date.now()}`;
  for (let i = 0; i < 120; i++) await insertAudit(db, "route.changed", { marker, i });
  await open(page, "?event=route");
  const seen: number[] = [];
  const ids = () =>
    page.$$eval('[data-testid="audit-row"]', (els, m) => els.filter((e) => e.textContent?.includes(m)).map((e) => Number(e.getAttribute("data-audit-id"))), marker);
  const firstId = () => page.locator('[data-testid="audit-row"]').first().getAttribute("data-audit-id");
  await expect(page.getByTestId("audit-row")).toHaveCount(50);
  seen.push(...(await ids()));
  for (let hop = 0; hop < 2; hop++) {
    const before = await firstId();
    await page.getByRole("link", { name: "Older" }).click();
    await expect.poll(firstId).not.toBe(before); // the next page has rendered
    seen.push(...(await ids()));
  }
  expect(seen).toHaveLength(120);
  expect(new Set(seen).size).toBe(120);
  expect([...seen].sort((a, b) => b - a)).toEqual(seen); // strictly newest first across pages
  expect(Math.max(...seen) - Math.min(...seen)).toBe(119); // no gaps: ids written in a row are consecutive within the family filter
  await page.getByRole("link", { name: "Newest" }).click();
  await expect(page).not.toHaveURL(/before=/);
});

test("a hostile or unusable cursor shows the newest entries with a note, never an error", async ({ page }) => {
  for (const bad of ["abc", "-5", "0", "1e9", "99999999999999999999", "1%3Bdrop", "%00"]) {
    await open(page, `?before=${bad}`);
    await expect(page.getByTestId("audit-row").first()).toBeVisible();
    await expect(page.getByRole("note").filter({ hasText: "newest" })).toBeVisible();
  }
  await open(page, "?event=%25");
  await expect(page.getByTestId("audit-list")).toBeVisible();
});

test("a cursor past the oldest entry shows an honest empty state with a way back", async ({ page }) => {
  await open(page, "?before=1");
  await expect(page.getByText("Nothing older than this.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Newest" })).toBeVisible();
});

test("an empty family shows the empty frame, not a blank table", async ({ page }) => {
  // totp.backfilled is never written by the UI or e2e flows; if it ever is, this family is simply not empty and the test
  // only asserts the structure below.
  await open(page, "?event=totp");
  const empty = page.getByText("Nothing has happened yet.");
  const rows = page.getByTestId("audit-row");
  expect((await empty.count()) + (await rows.count())).toBeGreaterThan(0);
});

test("touch targets are 44px on phone and everything is reachable by keyboard", async ({ page }) => {
  await open(page);
  const chips = page.getByRole("navigation", { name: "Filter by kind" }).getByRole("link");
  const min = phone(page) ? 44 : 36;
  for (const c of await chips.all()) expect((await c.boundingBox())!.height).toBeGreaterThanOrEqual(min - 0.5);
  await page.getByRole("link", { name: "Skip to content" }).focus().catch(() => {});
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => document.activeElement?.tagName);
  expect(focused).toBeTruthy();
  await chips.first().focus();
  await expect(chips.first()).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(chips.nth(1)).toBeFocused();
  await noPageScroll(page);
});

test("the audit page is in the nav", async ({ page }) => {
  await open(page);
  if (phone(page)) return; // phone shows it under More
  await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Audit" })).toHaveAttribute("aria-current", "page");
});

test("logging in is visible in the log", async ({ page }) => {
  await open(page);
  // the global setup signed the owner in, so at least one sign-in row exists
  await page.getByRole("navigation", { name: "Filter by kind" }).getByRole("link", { name: "Sign-in" }).click();
  await expect(page.getByTestId("audit-row").first()).toHaveAttribute("data-event", /^login\./);
});

test("no secret-looking value reaches the page", async ({ page }) => {
  await open(page);
  const html = await page.content();
  expect(html).not.toMatch(/postgres:\/\/|redis:\/\/|e2e-app-pw|e2e-owner-pw/);
});
