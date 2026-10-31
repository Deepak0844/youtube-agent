import { expect, test, type Page } from "@playwright/test";
import { db, endQueuePool, costPlan, script } from "../fixtures/queue";
import { sha256Hex } from "@/server/core/content-hash";
import { addContent, createVideoRow } from "@/server/db/videos";

test.afterAll(async () => {
  await endQueuePool();
});
const noPageScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

test("a new video: tabs switch by ?tab= and each empty tab says so", async ({ page }) => {
  const v = await createVideoRow(db(), { format: "short", kind: "scene_kit", language: "en", topic: `Empty tabs ${Date.now()}` });
  await page.goto(`/videos/${v.id}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Empty tabs");
  await expect(page.getByTestId("stage-strip").locator("li")).toHaveCount(7);
  await expect(page.getByTestId("tab-panel")).toHaveAttribute("data-tab", "script");
  await expect(page.getByTestId("empty")).toContainText("No script yet");
  for (const [tab, text] of [["beats", "No beats yet"], ["evidence", "No evidence yet"], ["titles", "No titles yet"], ["cost", "No cost plan yet"], ["qa", "No quality check yet"], ["audit", "Nothing in the audit log"], ["log", "Nothing logged yet"]] as const) {
    await page.goto(`/videos/${v.id}?tab=${tab}`);
    await expect(page.getByTestId("tab-panel")).toHaveAttribute("data-tab", tab);
    await expect(page.getByTestId("tab-panel")).toContainText(text);
  }
  await page.goto(`/videos/${v.id}?tab=bogus`);
  await expect(page.getByTestId("tab-panel")).toHaveAttribute("data-tab", "script");
  await noPageScroll(page);
});

test("a seeded video shows its script, beats and cost", async ({ page }) => {
  const topic = `Seeded ${Date.now()}`;
  const v = await createVideoRow(db(), { format: "short", kind: "scene_kit", language: "en", topic });
  await addContent(db(), v.id, "script", { body: script(topic), sha256: sha256Hex(`s${v.id}`) });
  await addContent(db(), v.id, "beats", { body: { beats: [{ id: "hook", text: "hook" }, { id: "why", text: "why" }] }, sha256: sha256Hex(`b${v.id}`) });
  await addContent(db(), v.id, "cost_plan", { body: costPlan, sha256: sha256Hex(`c${v.id}`) });
  await page.goto(`/videos/${v.id}`);
  await expect(page.getByTestId("script-text")).toContainText("air scatters blue light");
  await page.goto(`/videos/${v.id}?tab=beats`);
  await expect(page.getByTestId("beat-list").locator("li")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Re-check scenes (free)" })).toBeVisible();
  await page.goto(`/videos/${v.id}?tab=cost`);
  await expect(page.getByTestId("tab-panel")).toContainText("$2.5");
  await noPageScroll(page);
});
