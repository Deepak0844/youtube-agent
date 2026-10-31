import { expect, test, type Page } from "@playwright/test";

// Runs with the seeded owner's session. Projects share one database, so every test sets the state it needs first.
const phone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 768;

async function open(page: Page) {
  await page.goto("/settings/system");
  await page.waitForLoadState("networkidle"); // forms are client components: act only after hydration
  await expect(page.getByRole("heading", { level: 1, name: "System" })).toBeVisible();
}
const services = (page: Page) => page.getByLabel("Allowed local services, one per line");

async function saveServices(page: Page, text: string) {
  await services(page).fill(text);
  await page.getByLabel(/I understand the app will be allowed/).check(); // adding needs the confirmation tick
  // wait for the action's POST so an earlier "Saved." message cannot be mistaken for this save
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/settings/system")),
    page.getByRole("button", { name: "Save list" }).click(),
  ]);
  // the response arrives before React finishes the action (pending, form reset, new props); the button is enabled again only
  // when it has, so the next fill() cannot be overwritten by a late reset
  await expect(page.getByRole("button", { name: "Save list" })).toBeEnabled();
}

test("status shows reachability, vault, disk and versions, and no secrets", async ({ page }) => {
  await open(page);
  const status = page.getByRole("region", { name: "Status" });
  await expect(status.getByText("Database")).toBeVisible();
  await expect(status.getByText("Reachable").first()).toBeVisible();
  await expect(status.getByText("Key vault")).toBeVisible();
  await expect(status.getByText(/GB/).first()).toBeVisible();
  await expect(status.getByText(/node \d+\.\d+/)).toBeVisible();
  const html = await page.content();
  expect(html).not.toMatch(/postgres:\/\/|redis:\/\/|ytstudio_app|e2e-app-pw/);
});

test("the system page is in the nav and marked current", async ({ page }) => {
  await open(page);
  const link = page.getByRole("navigation", { name: phone(page) ? "Bottom" : "Primary" }).getByRole("link", { name: /System|More/ });
  if (!phone(page)) await expect(link).toHaveAttribute("aria-current", "page");
});

test("a good list saves, is shown normalised, and survives a reload", async ({ page }) => {
  await open(page);
  await saveServices(page, "LOCALHOST:11434\n127.0.0.1:1234\nlocalhost:11434");
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(services(page)).toHaveValue("localhost:11434\n127.0.0.1:1234");
});

test("hostile entries are refused line by line and nothing is saved", async ({ page }) => {
  await open(page);
  await saveServices(page, "localhost:11434");
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  const typed = "localhost:11434\n0.0.0.0:11434\n127.0.0.1:5432\n2130706433:80\n[::ffff:127.0.0.1]:80\n169.254.169.254:80";
  await saveServices(page, typed);
  // a refusal must not wipe what was typed: the line numbers in the message refer to it
  await expect(services(page)).toHaveValue(typed);
  const alert = page.locator("main [role=alert]");
  await expect(alert).toContainText("Nothing was saved");
  for (const n of [2, 3, 4, 5, 6]) await expect(alert).toContainText(`Line ${n}:`);
  await expect(alert).not.toContainText("Line 1:");
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(services(page)).toHaveValue("localhost:11434");
});

test("removing every entry is allowed", async ({ page }) => {
  await open(page);
  await saveServices(page, "localhost:11434");
  await saveServices(page, "");
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  await page.reload();
  await expect(services(page)).toHaveValue("");
});

test("limits save and invalid numbers are refused", async ({ page }) => {
  await open(page);
  const jobs = page.getByLabel("Jobs running at once");
  await jobs.fill("3");
  await page.getByRole("button", { name: "Save limits" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Jobs running at once")).toHaveValue("3");
  // the browser's own constraint blocks 0; bypass it to prove the server refuses too
  await page.getByLabel("Jobs running at once").evaluate((el: HTMLInputElement) => {
    el.removeAttribute("min");
    el.value = "0";
    el.form!.noValidate = true;
  });
  await page.getByRole("button", { name: "Save limits" }).click();
  await expect(page.locator("main [role=alert]")).toContainText("whole numbers");
  await page.reload();
  await expect(page.getByLabel("Jobs running at once")).toHaveValue("3");
  await page.getByLabel("Jobs running at once").fill("2");
  await page.getByRole("button", { name: "Save limits" }).click();
});

test("later ways to make a video are disabled with their phase", async ({ page }) => {
  await open(page);
  await expect(page.getByText("Code scenes (Phase 4)")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Collage (Phase 8)" })).toBeDisabled();
});

test("layout: no horizontal scroll, 44 px touch targets on phone, labels on every field", async ({ page }) => {
  await open(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const name of ["Videos rendering at once", "Jobs running at once", "Storage warning (GB)", "Longest long video (minutes)"]) {
    const box = await page.getByLabel(name).boundingBox();
    expect(box, name).not.toBeNull();
    if (phone(page)) expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  if (phone(page)) {
    for (const b of ["Save limits", "Save list"]) expect((await page.getByRole("button", { name: b }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({ path: `test-results/system-${phone(page) ? "390" : "1440"}.png`, fullPage: true });
});
