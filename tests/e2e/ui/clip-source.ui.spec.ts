import path from "node:path";
import { expect, test } from "@playwright/test";
import { endSessionPool } from "../fixtures/sessions";

// Runs with the seeded owner's session at 1440 and 390 wide. There is no worker in the e2e run, so an upload stays queued: the page opens the new
// video's Clips tab, which says clips can be cut once the video is prepared.
test.afterAll(endSessionPool);
const MP4 = path.join(process.cwd(), "tests/fixtures/video/good.mp4");

test("the Cut clips from a video page: pick a file, upload it, land on the new video's Clips tab", async ({ page }) => {
  await page.goto("/videos");
  await page.getByRole("link", { name: "Cut clips from a video" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Cut clips from your video" })).toBeVisible();
  const send = page.getByRole("button", { name: "Upload and prepare" });
  await expect(send).toBeDisabled();
  await page.getByLabel("Language spoken in the video").selectOption("en");
  await page.getByLabel("Video file").setInputFiles(MP4);
  await expect(send).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await send.click();
  await page.waitForURL(/\/videos\/[0-9a-f-]{36}\?tab=clips$/, { timeout: 60_000 });
  await expect(page.getByTestId("tab-panel")).toHaveAttribute("data-tab", "clips");
  await expect(page.getByTestId("tab-panel")).toContainText("Clips can be cut once this video has finished");
});
