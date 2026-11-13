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

test("New short -> the video page -> it shows in Videos with its language", async ({ page }) => {
  const topic = `Why the sea is salty ${stamp()}`;
  await page.goto("/videos/new");
  await page.waitForLoadState("networkidle"); // client form: act only after hydration
  await expect(page.getByRole("heading", { level: 1, name: "New video" })).toBeVisible();
  await expect(page.getByRole("radio", { name: /Scene kit/ })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: /Custom animation/ })).toBeChecked();
  await expect(page.getByLabel("Format").locator("option:disabled")).toHaveCount(0); // Long is selectable since Phase 6b.2
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
  await expect(page.getByRole("heading", { level: 1, name: "Videos" })).toBeVisible();
  const item = page.locator("[data-video]", { hasText: topic });
  await expect(item).toHaveCount(1);
  await expect(item).toContainText("Tamil");
  await expect(item).toContainText("so far");
  await item.getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/videos/${row[0].id}$`));
});

test("Videos filters narrow the list and an unmatched filter shows the empty state", async ({ page }) => {
  const topic = `Filter me ${stamp()}`;
  await page.goto("/videos/new");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Topic").fill(topic);
  await page.getByLabel("Narration language").selectOption("ml");
  await page.getByRole("button", { name: "Start video" }).click();
  await page.waitForURL(/\/videos\/[0-9a-f-]{36}$/);

  await page.goto("/videos?language=ml");
  await expect(page.locator("[data-video]", { hasText: topic })).toHaveCount(1);
  await page.goto("/videos?language=hi");
  await expect(page.locator("[data-video]", { hasText: topic })).toHaveCount(0);
  await page.goto("/videos?format=long");
  await expect(page.getByRole("heading", { name: "No results for these filters" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Clear filters" })).toHaveAttribute("href", "/videos");
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

test("nav: Videos and New video are reachable and only the current one is marked", async ({ page }) => {
  const phone = (page.viewportSize()?.width ?? 1440) < 768;
  await page.goto("/videos/new");
  await page.waitForLoadState("networkidle");
  if (phone) await page.getByRole("navigation", { name: "Bottom" }).getByRole("button", { name: "Make" }).click();
  const nav = page.getByRole("navigation", { name: phone ? "Make pages" : "Primary" });
  await expect(nav.getByRole("link", { name: "New video" })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: "Videos" })).not.toHaveAttribute("aria-current", /.+/);
});

test("the New form offers the AI video type with its character picker and says when no provider is chosen yet", async ({ page }) => {
  await page.goto("/videos/new");
  await page.waitForLoadState("networkidle");
  const ai = page.getByRole("radio", { name: /AI video/ });
  await expect(ai).not.toBeChecked();
  await expect(page.getByTestId("ai-options")).toHaveCount(0);
  await ai.check();
  await expect(page.getByTestId("ai-options")).toBeVisible();
  await expect(page.getByLabel("Character picture")).toHaveValue("");
  await expect(page.getByTestId("ai-route-note")).toContainText("No AI video provider and model are chosen yet");
  await page.getByLabel("Format").selectOption("long");
  await expect(ai).toBeDisabled(); // no type makes long videos now
  await noPageScroll(page);
});

test("the New form offers the Collage type, which is a Short with the usual look pickers", async ({ page }) => {
  await page.goto("/videos/new");
  await page.waitForLoadState("networkidle");
  const c = page.getByRole("radio", { name: /Collage/ });
  await expect(c).not.toBeChecked();
  await c.check();
  await expect(page.getByText("Style", { exact: true })).toBeVisible();
  await expect(page.getByTestId("ai-options")).toHaveCount(0);
  await page.getByLabel("Format").selectOption("long");
  await expect(c).toBeDisabled();
  await noPageScroll(page);
});

test("pages: changing a filter on page 2 goes back to page 1", async ({ page }) => {
  await page.goto("/videos?page=2&size=25");
  await page.getByRole("navigation", { name: "Format" }).getByRole("link", { name: "Short" }).click();
  await expect(page).not.toHaveURL(/page=/);
});

test("New long video opens the form on Long", async ({ page }) => {
  await page.goto("/videos/new?format=long");
  await expect(page.getByLabel("Format")).toHaveValue("long");
  await expect(page.getByTestId("long-length")).toBeVisible();
});
