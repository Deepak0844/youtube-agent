import { expect, test, type Page } from "@playwright/test";
import { addContent } from "@/server/db/videos";
import { sha256Hex } from "@/server/core/content-hash";
import { advance, db, endQueuePool, script, seedLookGate, seedParked, seedPublishGate, seedScriptGate, workerFinishes } from "../fixtures/queue";

// Runs with the seeded owner's session at 1440 and 390 wide. There is no worker in the e2e run: a "worker" step is played by
// claiming and committing the queued stage row in the database, exactly the rows the real worker would write. Every test
// seeds its own video (unique topic) and looks only at its own card, because the database is shared across specs.
test.afterAll(async () => {
  await endQueuePool();
});

const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const card = (page: Page, topic: string) => page.getByRole("article", { name: new RegExp(topic) });
const count = async (sql: string, args: unknown[] = []) => Number((await db().query(sql, args)).rows[0].n);
const noPageScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

// The queue is an inbox: pick the test's own item in the list to open its card on the right (phone: full screen).
const listItem = (page: Page, topic: string) => page.getByRole("region", { name: "Waiting on you" }).getByRole("link", { name: new RegExp(topic) });
async function open(page: Page, topic?: string) {
  await page.goto("/queue");
  await expect(page.getByRole("heading", { level: 1, name: "Queue" })).toBeVisible();
  // Click only when the item is not already open: re-clicking the open item keeps the same card (and its "what you saw"
  // snapshot), so a gate that settled in between would rightly show as changed and keep Approve off.
  if (topic && !(await card(page, topic).isVisible())) await listItem(page, topic).click();
  if (topic) await expect(card(page, topic)).toBeVisible();
}

async function axeViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
  const res = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<{ violations: Array<{ id: string; nodes: Array<{ target: unknown[] }> }> }> } }).axe;
    const r = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => String(n.target)).slice(0, 3).join(" | ")}`);
  });
  return res;
}

test("empty state and the nav entry", async ({ page }) => {
  await db().query("update videos set status = 'cancelled' where status in ('active','waiting')");
  await open(page);
  await expect(page.getByTestId("queue-count")).toHaveText("Nothing is waiting on you.");
  const phone = (page.viewportSize()?.width ?? 1440) < 768;
  const nav = page.getByRole("navigation", { name: phone ? "Bottom" : "Primary" });
  await expect(nav.getByRole(phone ? "button" : "link", { name: phone ? "Make" : "Queue" }).first()).toBeVisible();
  await noPageScroll(page);
});

test("script gate: shows the text, word count, evidence and the review reference; approve advances to the cost gate live, without a reload", async ({ page }) => {
  const topic = `journey ${stamp()}`;
  const { videoId } = await seedScriptGate(topic, { withCost: true });
  await open(page, topic);
  const c = card(page, topic);
  await expect(c).toBeVisible();
  await expect(c).toContainText("Script gate");
  await expect(c.getByTestId("script-text")).toContainText("The sky looks blue");
  await expect(c).toContainText(/\d+ words, 2 scenes/);
  await expect(c.getByRole("table")).toContainText("Air scatters blue light");
  await expect(c.getByTestId("review-ref")).toHaveText(/^[0-9a-f]{12}$/);
  await expect(c).toContainText("Held at the script gate");

  await page.evaluate(() => ((window as unknown as { __marker?: string }).__marker = "same-page"));
  await expect(page.getByTestId("live-feed")).toHaveAttribute("data-state", "live");
  await c.getByRole("button", { name: /^Approve script/ }).click();
  await expect(c).toHaveCount(0); // approved: the video moved on, the card goes

  // The worker finishes the build stage; the page learns about it through the live feed and shows the cost gate.
  expect(await workerFinishes(videoId, "pictures")).toBe(true);
  await advance(videoId);
  expect(await workerFinishes(videoId, "build")).toBe(true);
  await advance(videoId);
  const cost = card(page, topic);
  await expect(cost).toContainText("Cost gate", { timeout: 20_000 });
  await expect(cost.getByTestId("cost-total")).toHaveText("$2.50");
  await expect(cost).toContainText("Held at the cost gate");
  expect(await page.evaluate(() => (window as unknown as { __marker?: string }).__marker)).toBe("same-page"); // no reload happened
  expect(await count("select count(*)::int as n from approvals where video_id = $1 and gate = 'script' and decision = 'approved'", [videoId])).toBe(1);

  await cost.getByRole("button", { name: /^Approve cost/ }).click();
  await expect(cost).toHaveCount(0);
  expect(await count("select count(*)::int as n from approvals where video_id = $1 and gate = 'cost'", [videoId])).toBe(1);
});

test("send back needs a note, keeps what was typed when it is too short, and reruns the draft with the note", async ({ page }) => {
  const topic = `sendback ${stamp()}`;
  const { videoId } = await seedScriptGate(topic);
  await open(page, topic);
  const c = card(page, topic);
  const note = c.getByLabel("Send back with a note");
  await note.fill("ab");
  await c.getByRole("button", { name: /^Send back/ }).click();
  // The browser's own minlength check stops a short note before it is sent; nothing was recorded.
  expect(await count("select count(*)::int as n from approvals where video_id = $1", [videoId])).toBe(0);
  await note.fill("Make the opening shorter and name the source.");
  await c.getByRole("button", { name: /^Send back/ }).click();
  await expect(c).toHaveCount(0);
  expect(await count("select count(*)::int as n from approvals where video_id = $1 and decision = 'sent_back' and note = $2", [videoId, "Make the opening shorter and name the source."])).toBe(1);
  expect(await count("select count(*)::int as n from stage_runs where video_id = $1 and name = 'draft' and status = 'queued'", [videoId])).toBe(1);
});

test("a page that went stale says so, approves nothing and shows the new content", async ({ page }) => {
  const topic = `stale ${stamp()}`;
  const { videoId } = await seedScriptGate(topic);
  await open(page, topic);
  const c = card(page, topic);
  const before = await c.getByTestId("review-ref").textContent();
  // Pause the live feed (as a hidden tab does) so the page cannot refresh itself to the new version before the click:
  // this test is about a page that really went stale.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.getByTestId("live-feed")).toHaveAttribute("data-state", "paused");
  // Also refuse the page's background re-render requests (router refresh / prefetch revalidation), so nothing but the
  // click can bring the new version in. The approve itself is a POST and still goes through.
  await page.route((url) => url.searchParams.has("_rsc"), (route) => route.abort());
  await addContent(db(), videoId, "script", { body: script(topic), sha256: sha256Hex(`script-new-${videoId}`) });
  await c.getByRole("button", { name: /^Approve script/ }).click();
  await expect(c.getByRole("alert").filter({ hasText: "Review again." }).first()).toHaveText("This changed while you were looking. Review again.");
  expect(await count("select count(*)::int as n from approvals where video_id = $1", [videoId])).toBe(0);
  await expect(c.getByTestId("review-ref")).not.toHaveText(before!); // the card was reloaded with the new version
  // The old hash is never swapped silently: the buttons stay off until the owner says the new version was reviewed.
  await expect(c.getByTestId("changed-notice")).toBeVisible();
  await expect(c.getByRole("button", { name: /^Approve script/ })).toBeDisabled();
  await c.getByRole("button", { name: "I reviewed the new version" }).click();
  await c.getByRole("button", { name: /^Approve script/ }).click();
  await expect(c).toHaveCount(0);
  expect(await count("select count(*)::int as n from approvals where video_id = $1 and decision = 'approved'", [videoId])).toBe(1);
});

test("a parked step shows the dollar figure and the choices, and a release needs the billing check", async ({ page }) => {
  const topic = `parked ${stamp()}`;
  const { videoId, stageId } = await seedParked(topic);
  await open(page, topic);
  const c = card(page, topic);
  await expect(c).toContainText("Needs your decision");
  await expect(c.getByTestId("decision-figure")).toHaveText("$0.25");
  await expect(c.getByTestId("decision-summary")).toContainText("$0.25");
  await expect(c.getByRole("button")).toHaveText(["Nothing was charged: run it again", "It was charged: count it and run again", "Cancel this video"]);
  await c.getByRole("button", { name: "Nothing was charged: run it again" }).click(); // box not ticked: the browser blocks it
  expect(await count("select count(*)::int as n from stage_runs where id = $1 and status = 'needs_decision'", [stageId])).toBe(1);
  await c.getByLabel("I checked the provider's billing page").first().check();
  await c.getByRole("button", { name: "Nothing was charged: run it again" }).click();
  await expect(c).toHaveCount(0);
  expect(await count("select count(*)::int as n from stage_runs where video_id = $1 and name = 'draft'", [videoId])).toBe(2);
});

test("keyboard only: Tab to the approve button of one gate and press Enter", async ({ page }) => {
  const topic = `keyboard ${stamp()}`;
  const { videoId } = await seedScriptGate(topic);
  await open(page, topic);
  await expect(card(page, topic)).toBeVisible();
  await page.locator("main").press("Tab"); // leave the skip-link/shell region behind from the page start
  let reached = false;
  for (let n = 0; n < 120 && !reached; n++) {
    reached = await page.evaluate((t) => (document.activeElement as HTMLElement | null)?.getAttribute("aria-label") === `Approve script: ${t}`, topic);
    if (!reached) await page.keyboard.press("Tab");
  }
  expect(reached).toBe(true);
  await expect(page.locator(":focus")).toHaveCSS("outline-style", "solid"); // a visible focus ring
  await page.keyboard.press("Enter");
  await expect(card(page, topic)).toHaveCount(0);
  expect(await count("select count(*)::int as n from approvals where video_id = $1 and decision = 'approved'", [videoId])).toBe(1);
});

test("publish gate names the channel and visibility, and approving queues one upload", async ({ page }) => {
  const topic = `publish ${stamp()}`;
  const { videoId } = await seedPublishGate(topic, "unlisted");
  await open(page, topic);
  const c = card(page, topic);
  await expect(c).toContainText("Publish gate");
  await expect(c.getByTestId("publish-channel")).toHaveText("UC-e2e");
  await expect(c.getByTestId("publish-visibility")).toHaveText("unlisted");
  await expect(c.locator("video")).toHaveAttribute("src", /^\/api\/media\/queue-e2e\/.+\?e=\d+&s=/);
  await c.getByRole("button", { name: /^Approve and publish/ }).click();
  await expect(c).toHaveCount(0);
  expect(await count("select count(*)::int as n from uploads where video_id = $1 and status = 'publish_approved'", [videoId])).toBe(1);
});

test("accessibility: no axe violations with the inbox list and an open card; no horizontal scroll", async ({ page }) => {
  const a = `axe-a ${stamp()}`;
  const b = `axe-b ${stamp()}`;
  const p = `axe-p ${stamp()}`;
  const d = `axe-d ${stamp()}`;
  await seedScriptGate(a);
  await seedScriptGate(b, { withCost: true });
  await seedPublishGate(p);
  await seedParked(d);
  await open(page);
  for (const t of [a, p, d]) await expect(listItem(page, t)).toBeVisible();
  await listItem(page, d).click();
  await expect(card(page, d)).toBeVisible();
  await expect(page.getByTestId("live-feed")).toHaveAttribute("data-state", "live");
  expect(await axeViolations(page)).toEqual([]);
  await noPageScroll(page);
});

test("the live feed closes when the tab is hidden and reopens when it is visible again", async ({ page }) => {
  await open(page);
  const feed = page.getByTestId("live-feed");
  await expect(feed).toHaveAttribute("data-state", "live");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(feed).toHaveAttribute("data-state", "paused");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(feed).toHaveAttribute("data-state", "live");
});

test("look gate: a contact sheet of the preview pictures with shots and times, what was not found, the advice; fits a phone; no accessibility violations", async ({ page }) => {
  const topic = `look ${stamp()}`;
  const { shots } = await seedLookGate(topic, { advice: ["Image 2 is mostly empty sky."] });
  await open(page, topic);
  const c = card(page, topic);
  await expect(c).toBeVisible();
  await expect(c).toContainText("Look gate");
  await expect(c).toContainText("Held at the look gate");
  const sheet = c.getByTestId("look-sheet");
  await expect(sheet.getByRole("listitem")).toHaveCount(shots.length); // one per shot plus the middle of the longest (6 shots, 7 pictures)
  expect(shots).toHaveLength(7);
  await expect(sheet.getByRole("listitem").first()).toContainText("1. hook at 0.5 s");
  await expect(sheet.getByRole("listitem").first()).toContainText("Caption: Caption hook");
  await expect(c.getByTestId("look-missing")).toContainText("Scene dig: wanted an excavator; used a dump truck instead.");
  await expect(c.getByTestId("look-advice")).toContainText("Image 2 is mostly empty sky.");
  await expect(c.getByRole("note")).toHaveCount(1); // the advice block is the card's only note
  await expect(c.getByRole("button", { name: /^Approve look/ })).toBeEnabled();
  await expect(c.getByLabel("Send back with a note")).toBeVisible();
  await expect(c.getByTestId("review-ref")).toHaveText(/^[0-9a-f]{12}$/);
  await noPageScroll(page);
  expect(await axeViolations(page)).toEqual([]);
});

test("look gate: approving the look queues Render (and only then); the card goes", async ({ page }) => {
  const topic = `look-ok ${stamp()}`;
  const { videoId } = await seedLookGate(topic);
  expect(await count("select count(*)::int as n from stage_runs where video_id = $1 and name = 'render'", [videoId])).toBe(0);
  await open(page, topic);
  const c = card(page, topic);
  await c.getByRole("button", { name: /^Approve look/ }).click();
  await expect(c).toHaveCount(0);
  expect(await count("select count(*)::int as n from approvals where video_id = $1 and gate = 'look' and decision = 'approved'", [videoId])).toBe(1);
  expect(await count("select count(*)::int as n from stage_runs where video_id = $1 and name = 'render' and status = 'queued'", [videoId])).toBe(1);
});

test("look gate: send back needs a note and queues the director again with it", async ({ page }) => {
  const topic = `look-back ${stamp()}`;
  const { videoId } = await seedLookGate(topic);
  await open(page, topic);
  const c = card(page, topic);
  await c.getByLabel("Send back with a note").fill("More palm trees and a brighter sky.");
  await c.getByRole("button", { name: /^Send back/ }).click();
  await expect(c).toHaveCount(0);
  expect(await count("select count(*)::int as n from approvals where video_id = $1 and gate = 'look' and decision = 'sent_back' and note = $2", [videoId, "More palm trees and a brighter sky."])).toBe(1);
  expect(await count("select count(*)::int as n from stage_runs where video_id = $1 and name = 'direct_scene3d' and status = 'queued'", [videoId])).toBe(1);
  expect(await count("select count(*)::int as n from stage_runs where video_id = $1 and name = 'render'", [videoId])).toBe(0);
});

test("a 3D story's Preview tab shows the storyboard, what was not found and the preview pictures; fits a phone", async ({ page }) => {
  const topic = `look-tab ${stamp()}`;
  const { videoId } = await seedLookGate(topic);
  await page.goto(`/videos/${videoId}?tab=preview`);
  await expect(page.getByRole("heading", { level: 1, name: topic })).toBeVisible();
  await expect(page.getByTestId("scene3d-total")).toContainText("Total length 36 s, 6 shots");
  await expect(page.getByTestId("scene3d-shots").getByRole("row")).toHaveCount(7); // header and 6 shots
  await expect(page.getByTestId("scene3d-objects")).toContainText("box");
  await expect(page.getByTestId("scene3d-missing")).toContainText("Scene dig: wanted an excavator; used a dump truck instead.");
  await expect(page.getByRole("heading", { name: "Preview pictures" })).toBeVisible(); // the open Look card shows the same sheet above the tabs
  await expect(page.getByTestId("look-sheet").first().getByRole("listitem")).toHaveCount(7);
  await noPageScroll(page);
});
