import { expect, test, type Page } from "@playwright/test";
import { db, endQueuePool } from "../fixtures/queue";

// Runs with the seeded owner's session at 1440 and 390 wide. The database is shared across specs, so each test uses its own
// unique topic and looks only at its own row. There is no worker in the e2e run: the first stage is queued, nothing runs it.
test.afterAll(async () => {
  await endQueuePool();
});

const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const noPageScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

test("New short -> the video page -> it shows in the Library with its language", async ({ page }) => {
  const topic = `Why the sea is salty ${stamp()}`;
  await page.goto("/videos/new");
  await page.waitForLoadState("networkidle"); // client form: act only after hydration
  await expect(page.getByRole("heading", { level: 1, name: "New short" })).toBeVisible();
  await expect(page.getByLabel("Kind").locator("option:disabled")).toHaveCount(3);
  await expect(page.getByLabel("Format").locator("option:disabled")).toHaveCount(1);
  await noPageScroll(page);
  await page.getByLabel("Topic").fill(topic);
  await page.getByLabel("Narration language").selectOption("ta");
  await page.getByRole("button", { name: "Start video" }).click();
  await page.waitForURL(/\/videos\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1, name: topic })).toBeVisible();

  const row = (await db().query("select id, language, status from videos where topic = $1", [topic])).rows;
  expect(row).toHaveLength(1);
  expect(row[0].language).toBe("ta");

  await page.goto("/videos");
  await expect(page.getByRole("heading", { level: 1, name: "Library" })).toBeVisible();
  const item = page.locator("li[data-video]", { hasText: topic });
  await expect(item).toHaveCount(1);
  await expect(item).toContainText("Tamil");
  await expect(item).toContainText("so far");
  await item.getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/videos/${row[0].id}$`));
});

test("Library filters narrow the list and an unmatched filter shows the empty state", async ({ page }) => {
  const topic = `Filter me ${stamp()}`;
  await page.goto("/videos/new");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Topic").fill(topic);
  await page.getByLabel("Narration language").selectOption("ml");
  await page.getByRole("button", { name: "Start video" }).click();
  await page.waitForURL(/\/videos\/[0-9a-f-]{36}$/);

  await page.goto("/videos?language=ml");
  await expect(page.locator("li[data-video]", { hasText: topic })).toHaveCount(1);
  await page.goto("/videos?language=hi");
  await expect(page.locator("li[data-video]", { hasText: topic })).toHaveCount(0);
  await page.goto("/videos?format=long");
  await expect(page.getByText("No videos match these filters.")).toBeVisible();
  await noPageScroll(page);
});

test("New with an empty topic does not create a video", async ({ page }) => {
  const before = Number((await db().query("select count(*) as n from videos")).rows[0].n);
  await page.goto("/videos/new");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Topic").fill("   ");
  await page.getByRole("button", { name: "Start video" }).click();
  await expect(page).toHaveURL(/\/videos\/new$/);
  expect(Number((await db().query("select count(*) as n from videos")).rows[0].n)).toBe(before);
});

test("nav: Library and New are reachable and only the current one is marked", async ({ page }) => {
  const phone = (page.viewportSize()?.width ?? 1440) < 768;
  await page.goto("/videos/new");
  await page.waitForLoadState("networkidle");
  const nav = page.getByRole("navigation", { name: phone ? "Bottom" : "Primary" });
  await expect(nav.getByRole("link", { name: "New" })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: "Library" })).not.toHaveAttribute("aria-current", /.+/);
});
