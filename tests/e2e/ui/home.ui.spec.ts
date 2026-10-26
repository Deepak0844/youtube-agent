import { expect, test, type Page } from "@playwright/test";
import { installFakeClock } from "../fixtures/fake-clock";
import { OWNER_PASSWORD, OWNER_USERNAME } from "../fixtures/owner";

// Runs with the seeded owner's storageState (playwright.config.mts), i.e. reuse of a real session.
const phone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 768;

test("home shows honest zeros and the studio's question", async ({ page }) => {
  await installFakeClock(page, "2026-01-01T09:00:00Z");
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  await expect(page.getByTestId("waiting-count")).toHaveText("0");
  await expect(page.getByText("Waiting on you")).toBeVisible();
  await expect(page.getByText("Nothing is waiting for your decision.")).toBeVisible();
  await expect(page.getByText("No uploads yet.")).toBeVisible();
});

test("top bar carries real spend from budgets, review count and a disabled search", async ({ page }) => {
  await page.goto("/");
  const bar = page.getByRole("banner");
  await expect(bar.getByText(/^\$\d+\.\d{2} of \$\d+\.\d{2} today$/)).toBeVisible();
  await expect(bar.getByText("0 to review")).toBeAttached();
  if (!phone(page)) {
    await expect(bar.getByRole("searchbox", { name: "Search" })).toBeDisabled();
    await expect(bar.getByText("Search arrives in Phase 4")).toBeAttached();
  }
});

test("desktop: 210 px sidebar, active item marked beyond colour", async ({ page }) => {
  test.skip(phone(page), "desktop only");
  await page.goto("/");
  const side = page.getByRole("navigation", { name: "Primary" });
  expect((await page.locator("aside:has(nav[aria-label=Primary])").boundingBox())!.width).toBe(210);
  const home = side.getByRole("link", { name: "Home" });
  await expect(home).toHaveAttribute("aria-current", "page");
  const other = side.getByRole("link", { name: "Keys" });
  await expect(other).not.toHaveAttribute("aria-current", /.+/);
  const [wHome, wOther] = await Promise.all([home.evaluate((e) => getComputedStyle(e).fontWeight), other.evaluate((e) => getComputedStyle(e).fontWeight)]);
  expect(Number(wHome)).toBeGreaterThan(Number(wOther)); // weight differs, not only brightness
  const [cHome, cOther] = await Promise.all([home.evaluate((e) => getComputedStyle(e).color), other.evaluate((e) => getComputedStyle(e).color)]);
  expect(cHome).toBe("rgb(255, 255, 255)");
  expect(cOther).not.toBe(cHome);
  await expect(page.getByRole("navigation", { name: "Bottom" })).toBeHidden();
});

test("phone: bottom bar with 44 px targets, no sidebar, no horizontal scroll", async ({ page }) => {
  test.skip(!phone(page), "phone only");
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();
  const bar = page.getByRole("navigation", { name: "Bottom" });
  await expect(bar).toBeVisible();
  const items = bar.locator("a, button");
  expect(await items.count()).toBeLessThanOrEqual(5);
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
  await bar.getByRole("button", { name: "More" }).click();
  await expect(page.getByRole("dialog").getByRole("link", { name: "System" })).toBeVisible();
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

test("keyboard: landmarks exist and the nav links are reachable by Tab", async ({ page }) => {
  test.skip(phone(page), "desktop only");
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  for (const role of ["banner", "main"] as const) await expect(page.getByRole(role)).toBeVisible();
  const side = page.getByRole("navigation", { name: "Primary" });
  await expect(side.getByRole("link")).toHaveCount(6);
  await side.getByRole("link", { name: "Home" }).focus();
  for (const name of ["Models", "Keys", "Google app", "Audit", "System"]) {
    await page.keyboard.press("Tab");
    await expect(side.getByRole("link", { name })).toBeFocused();
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
