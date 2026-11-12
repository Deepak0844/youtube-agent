import { expect, test, type Page } from "@playwright/test";
import { visibleAreas } from "@/ui/shell/nav-config";
import { OWNER_PASSWORD, OWNER_USERNAME } from "../fixtures/owner";

// Runs with the seeded owner's storageState (playwright.config.mts), i.e. reuse of a real session.
const phone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 768;

test("wide screen: Recent activity sits in a right-hand column beside the lists", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 1280, "wide screens only");
  await page.goto("/");
  await expect(page.getByTestId("panel-queue")).toBeVisible(); // panels stream in: measure only once both are on the page
  await expect(page.getByTestId("panel-recent")).toBeVisible();
  const left = (await page.getByTestId("panel-queue").boundingBox())!;
  const right = (await page.getByTestId("panel-recent").boundingBox())!;
  expect(right.x).toBeGreaterThan(left.x + left.width - 1);
  expect(Math.round(right.width)).toBe(340);
});

test("home loads every panel (none failed, none stuck loading) and shows the quick links", async ({ page }) => {
  // The e2e database is shared with other specs that create videos, so this checks each panel's state, not that it is empty.
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  await expect(page.getByText("In production", { exact: true })).toBeVisible();
  for (const id of ["kpis", "queue", "attention", "active", "next", "recent"]) {
    const panel = page.getByTestId(`panel-${id}`);
    await expect(panel).toBeVisible();
    await expect(panel.locator(".animate-pulse")).toHaveCount(0);
    await expect(panel).not.toContainText("Could not load");
  }
  await expect(page.getByRole("link", { name: "New short" })).toHaveAttribute("href", /\/videos\/new\?format=short/);
  await expect(page.getByRole("link", { name: "New long video" })).toHaveAttribute("href", /\/videos\/new\?format=long/);
  for (const h of ["Needs you", "Needs attention", "Running now", "Up next", "Recent activity"]) await expect(page.getByRole("heading", { level: 2, name: h })).toBeVisible();
  await expect(page.getByText("Waiting on you", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("top bar carries real spend from budgets and the breadcrumb", async ({ page }) => {
  await page.goto("/");
  const bar = page.getByRole("banner");
  // Phone shows dollars only (the rupee text overflows 390 px); wider screens show dollars and rupees.
  const spend = phone(page) ? /^\$\d+\.\d{2} of \$\d+\.\d{2} today$/ : /^\$\d+\.\d{2} \(₹[\d,]+\.\d\) of \$\d+\.\d{2} \(₹[\d,]+\.\d\) today$/;
  await expect(bar.getByText(spend)).toBeVisible();
  if (!phone(page)) await expect(bar.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Home");
});

test("desktop: icon strip with five areas, no area menu on Home, active item marked beyond colour", async ({ page }) => {
  test.skip(phone(page), "desktop only");
  await page.goto("/");
  const rail = page.getByRole("navigation", { name: "Areas" });
  await expect(rail.getByRole("link")).toHaveCount(6); // the mark + five areas
  const home = rail.getByRole("link", { name: "Home", exact: true });
  await expect(home).toHaveAttribute("aria-current", "page");
  const other = rail.getByRole("link", { name: "Settings" });
  await expect(other).not.toHaveAttribute("aria-current", /.+/);
  const [wHome, wOther] = await Promise.all([home.evaluate((e) => getComputedStyle(e).fontWeight), other.evaluate((e) => getComputedStyle(e).fontWeight)]);
  expect(Number(wHome)).toBeGreaterThan(Number(wOther)); // weight differs, not only brightness
  await expect(page.getByRole("navigation", { name: "Primary" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Bottom" })).toBeHidden();
});

test("desktop: Settings shows its four named sections with the current page marked", async ({ page }) => {
  test.skip(phone(page), "desktop only");
  await page.goto("/settings/keys");
  await expect(page.getByRole("navigation", { name: "Areas" }).getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
  const menu = page.getByRole("navigation", { name: "Primary" });
  for (const s of ["You", "AI and media", "Money and safety", "System"]) await expect(menu.getByText(s, { exact: true }).first()).toBeVisible();
  await expect(menu.getByRole("link", { name: "Keys" })).toHaveAttribute("aria-current", "page");
  await expect(page).toHaveTitle("Keys · YT Studio");
});

test("phone: bottom bar with five areas and 44 px targets, no horizontal scroll", async ({ page }) => {
  test.skip(!phone(page), "phone only");
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("navigation", { name: "Areas" })).toBeHidden();
  const bar = page.getByRole("navigation", { name: "Bottom" });
  await expect(bar).toBeVisible();
  const items = bar.locator("a, button");
  expect(await items.count()).toBe(5);
  for (const b of await items.all()) {
    const box = (await b.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
  }
  await expect(bar.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
  const header = (await page.getByRole("banner").boundingBox())!;
  expect(header.height).toBeGreaterThanOrEqual(48);
  expect(header.height).toBeLessThanOrEqual(56);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await bar.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("dialog").getByRole("link", { name: "System", exact: true })).toBeVisible();
});

test("keyboard: skip link is the first tab stop and jumps to main", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator("main#main")).toBeFocused();
});

test("keyboard: landmarks exist and the area menu links are reachable by Tab", async ({ page }) => {
  test.skip(phone(page), "desktop only");
  await page.goto("/settings/account");
  await page.waitForLoadState("networkidle");
  for (const role of ["banner", "main"] as const) await expect(page.getByRole(role)).toBeVisible();
  const menu = page.getByRole("navigation", { name: "Primary" });
  // Derived from the nav config so adding a page does not break this test.
  const labels = visibleAreas().find((a) => a.area === "Settings")!.items.map((i) => i.label);
  await expect(menu.getByRole("link")).toHaveCount(labels.length);
  await menu.getByRole("link").first().focus();
  for (const [i, name] of labels.slice(1).entries()) {
    await page.keyboard.press("Tab");
    await expect(menu.getByRole("link").nth(i + 1)).toBeFocused();
    await expect(menu.getByRole("link").nth(i + 1)).toHaveText(name);
  }
});

test("sign out from the account menu ends the session", async ({ browser, baseURL }) => {
  // a separate session so the shared storage state keeps working for the other specs
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, extraHTTPHeaders: { "x-forwarded-for": "192.0.2.201" } });
  const page = await context.newPage();
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Username").fill(OWNER_USERNAME);
  await page.getByLabel("Password").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await context.close();
});

test("unauthenticated visit is redirected to /login", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await context.close();
});

test("jump-to: Ctrl+K, type a page name, Enter opens it", async ({ page }) => {
  test.skip(phone(page), "desktop only");
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.keyboard.press("Control+k");
  const box = page.getByRole("dialog");
  await expect(box).toBeVisible();
  await page.keyboard.type("keys");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/settings\/keys$/);
});

test("phone: Settings opens its pages in a sheet and nothing overflows", async ({ page }) => {
  test.skip(!phone(page), "phone only");
  await page.goto("/settings/keys");
  await page.getByRole("navigation", { name: "Bottom" }).getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("navigation", { name: "Settings pages" }).getByRole("link", { name: "Keys" })).toHaveAttribute("aria-current", "page");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= 390)).toBe(true);
});
