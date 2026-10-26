import { expect, test, type Browser } from "@playwright/test";
import { OWNER_PASSWORD, OWNER_USERNAME } from "../fixtures/owner";

// Fresh, logged-out context per test. TRUST_PROXY=1 on the e2e server: a unique x-forwarded-for per context keeps one
// test's failures (lockout is per username AND per address) from locking another.
async function fresh(browser: Browser) {
  const ip = `192.0.2.${Math.floor(Math.random() * 250) + 1}`;
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, extraHTTPHeaders: { "x-forwarded-for": ip } });
  return { context, page: await context.newPage() };
}
async function signIn(page: import("@playwright/test").Page, username: string, password: string) {
  await page.waitForLoadState("networkidle"); // controlled inputs: typing before hydration would be overwritten
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}
const uname = (p: string) => `${p}-${Math.random().toString(36).slice(2, 10)}`;

test("wrong password shows one generic message, same for unknown user", async ({ browser }) => {
  const { context, page } = await fresh(browser);
  await page.goto("/login");
  await signIn(page, uname("nobody"), "wrong-password-123");
  await expect(page.locator("form p[role=alert]")).toHaveText("Incorrect username or password.");
  await expect(page.locator("form p[role=alert]")).toHaveCount(1);
  await signIn(page, OWNER_USERNAME, "wrong-password-123");
  await expect(page.locator("form p[role=alert]")).toHaveText("Incorrect username or password.");
  await expect(page).toHaveURL(/\/login/);
  await context.close();
});

test("correct login reaches the protected page, cookie is HttpOnly, logout returns to /login", async ({ browser }) => {
  const { context, page } = await fresh(browser);
  await page.goto("/");
  await expect(page).toHaveURL(/\/login\?next=%2F$/);
  await signIn(page, OWNER_USERNAME, OWNER_PASSWORD);
  await expect(page.getByRole("heading", { name: "YT Studio" })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");
  expect(await page.evaluate(() => document.cookie)).not.toContain("ytstudio_session");
  const c = (await context.cookies()).find((x) => x.name === "ytstudio_session")!;
  expect(c).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/", secure: false });

  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/login\?next=%2F$/);
  await context.close();
});

for (const evil of ["//evil.test", "https://evil.test", "/\\evil.test", "javascript:alert(1)"]) {
  test(`open redirect is neutralised: next=${evil}`, async ({ browser, baseURL }) => {
    const { context, page } = await fresh(browser);
    await page.goto(`/login?next=${encodeURIComponent(evil)}`);
    await signIn(page, OWNER_USERNAME, OWNER_PASSWORD);
    await expect(page.getByRole("heading", { name: "YT Studio" })).toBeVisible();
    expect(new URL(page.url()).origin).toBe(new URL(baseURL!).origin);
    expect(new URL(page.url()).pathname).toBe("/");
    await context.close();
  });
}

// Runs last in this file: 5 failures lock this test's own (username, address) pair only.
test("lockout message appears after 5 failures", async ({ browser }) => {
  const { context, page } = await fresh(browser);
  const name = uname("lockui");
  await page.goto("/login");
  for (let i = 0; i < 5; i++) {
    await signIn(page, name, "wrong-password-123");
    await expect(page.locator("form p[role=alert]")).toHaveText("Incorrect username or password.");
  }
  await signIn(page, name, "wrong-password-123");
  await expect(page.locator("form p[role=alert]")).toHaveText(/Too many attempts\. Try again in 1 minute/);
  await context.close();
});
