import { expect, test, type Page } from "@playwright/test";
import { addContent } from "@/server/db/videos";
import { sha256Hex } from "@/server/core/content-hash";
import { advance, db, endQueuePool, script, seedParked, seedPublishGate, seedScriptGate, workerFinishes } from "../fixtures/queue";

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

async function open(page: Page) {
  await page.goto("/queue");
  await expect(page.getByRole("heading", { level: 1, name: "Queue" })).toBeVisible();
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
  const nav = page.getByRole("navigation", { name: (page.viewportSize()?.width ?? 1440) < 768 ? "Bottom" : "Primary" });
  await expect(nav.getByRole("link", { name: /Queue|More/ }).first()).toBeVisible();
  await noPageScroll(page);
});

test("script gate: shows the text, word count, evidence and the review reference; approve advances to the cost gate live, without a reload", async ({ page }) => {
  const topic = `journey ${stamp()}`;
  const { videoId } = await seedScriptGate(topic, { withCost: true });
  await open(page);
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
  await open(page);
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
  await open(page);
  const c = card(page, topic);
  const before = await c.getByTestId("review-ref").textContent();
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
  await open(page);
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
  await open(page);
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
  await open(page);
  const c = card(page, topic);
  await expect(c).toContainText("Publish gate");
  await expect(c.getByTestId("publish-channel")).toHaveText("UC-e2e");
  await expect(c.getByTestId("publish-visibility")).toHaveText("unlisted");
  await expect(c.locator("video")).toHaveAttribute("src", /^\/api\/media\/queue-e2e\/.+\?e=\d+&s=/);
  await c.getByRole("button", { name: /^Approve and publish/ }).click();
  await expect(c).toHaveCount(0);
  expect(await count("select count(*)::int as n from uploads where video_id = $1 and status = 'publish_approved'", [videoId])).toBe(1);
});

test("accessibility: no axe violations with every kind of card on the page; no horizontal scroll", async ({ page }) => {
  const a = `axe-a ${stamp()}`;
  const b = `axe-b ${stamp()}`;
  const p = `axe-p ${stamp()}`;
  const d = `axe-d ${stamp()}`;
  await seedScriptGate(a);
  await seedScriptGate(b, { withCost: true });
  await seedPublishGate(p);
  await seedParked(d);
  await open(page);
  for (const t of [a, p, d]) await expect(card(page, t)).toBeVisible();
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
