import { expect, test } from "@playwright/test";
import { advance, db, endQueuePool, seedScriptGate, workerFinishes } from "../fixtures/queue";

test.afterAll(async () => {
  await endQueuePool();
});

test("the queue carries one short from script review to generation without a page reload", async ({ page }) => {
  const topic = `phase-2-journey-${Date.now()}`;
  const { videoId } = await seedScriptGate(topic, { withCost: true });
  await page.goto("/queue");

  const card = page.getByRole("article", { name: new RegExp(topic) });
  await expect(card).toContainText("Script gate");
  await expect(card.getByTestId("script-text")).toBeVisible();
  await page.evaluate(() => ((window as unknown as { phase2Marker?: string }).phase2Marker = "kept"));
  await card.getByRole("button", { name: /^Approve script/ }).click();
  await expect(card).toHaveCount(0);

  expect(await workerFinishes(videoId, "build")).toBe(true);
  await advance(videoId);
  const cost = page.getByRole("article", { name: new RegExp(topic) });
  await expect(cost).toContainText("Cost gate", { timeout: 20_000 });
  await expect(cost.getByTestId("cost-total")).toHaveText("$2.50");
  expect(await page.evaluate(() => (window as unknown as { phase2Marker?: string }).phase2Marker)).toBe("kept");
  await cost.getByRole("button", { name: /^Approve cost/ }).click();
  await expect(cost).toHaveCount(0);

  const generate = await db().query<{ status: string }>("select status from stage_runs where video_id = $1 and name = 'generate'", [videoId]);
  expect(generate.rows).toEqual([{ status: "queued" }]);
});
