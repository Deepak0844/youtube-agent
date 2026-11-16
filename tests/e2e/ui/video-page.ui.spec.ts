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
  const v = await createVideoRow(db(), { format: "short", kind: "collage", language: "en", topic: `Empty tabs ${Date.now()}` });
  await page.goto(`/videos/${v.id}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Empty tabs");
  await expect(page.getByTestId("stage-strip").locator("li")).toHaveCount(7);
  await expect(page.getByTestId("tab-panel")).toHaveAttribute("data-tab", "script");
  await expect(page.getByTestId("empty")).toContainText("No script yet");
  for (const [tab, text] of [["beats", "No beats yet"], ["evidence", "No evidence yet"], ["titles", "No titles yet"], ["clips", "No clips yet"], ["cost", "No cost plan yet"], ["qa", "No quality check yet"], ["audit", "Nothing in the audit log"], ["log", "Nothing logged yet"]] as const) {
    await page.goto(`/videos/${v.id}?tab=${tab}`);
    await expect(page.getByTestId("tab-panel")).toHaveAttribute("data-tab", tab);
    await expect(page.getByTestId("tab-panel")).toContainText(text);
  }
  await page.goto(`/videos/${v.id}?tab=bogus`);
  await expect(page.getByTestId("tab-panel")).toHaveAttribute("data-tab", "script");
  await noPageScroll(page);
});

test("the Clips tab shows the newest batch with each clip's checks and a tick to make a Short", async ({ page }) => {
  const v = await createVideoRow(db(), { format: "short", kind: "tsx", language: "en", topic: `Clips ${Date.now()}` });
  await db().query("insert into stage_runs (id, video_id, name, status, input_hash) values (gen_random_uuid(), $1, 'qa', 'succeeded', 'h')", [v.id]);
  const clip = (id: string, hook: string) => ({ id, startS: 1, endS: 31, durationS: 30, hook, score: 0.8, reason: "r", words: [], file: `clips-b1-${id}.mp4` });
  const body = {
    sourceVideoId: v.id, batch: 1, measured: {},
    clips: [clip("c1", "Why is the sky blue?"), clip("c2", "And then it gets loud")],
    review: { needAttention: 1, clips: [{ id: "c1", hook: "Why is the sky blue?", durationS: 30, checks: [], ok: true, warnings: [] }, { id: "c2", hook: "And then it gets loud", durationS: 30, checks: [], ok: false, warnings: ["Loudness is -8.0 LUFS; aim for -20 to -12 so the batch sounds even."] }] },
  };
  await addContent(db(), v.id, "clip_batch", { body, sha256: sha256Hex(`cb${v.id}`) });
  await page.goto(`/videos/${v.id}?tab=clips`);
  await expect(page.getByTestId("tab-panel")).toHaveAttribute("data-tab", "clips");
  await expect(page.getByRole("heading", { name: /Batch 1: 2 clips, 1 with a check/ })).toBeVisible();
  const cards = page.getByTestId("clip-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText("All checks passed");
  await expect(cards.nth(0).getByRole("checkbox")).toBeChecked();
  await expect(cards.nth(1)).toContainText("Loudness is -8.0 LUFS");
  await expect(cards.nth(1).getByRole("checkbox")).not.toBeChecked(); // a clip with a warning starts unticked
  await expect(page.getByRole("button", { name: "Make Shorts of the ticked clips" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Cut a new batch" })).toBeEnabled();
  await noPageScroll(page);
});

test("a seeded video shows its script, beats and cost", async ({ page }) => {
  const topic = `Seeded ${Date.now()}`;
  const v = await createVideoRow(db(), { format: "short", kind: "collage", language: "en", topic });
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
