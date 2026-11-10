import { expect, test, type Page } from "@playwright/test";

// The Account page with the seeded owner's session. The SUCCESS path of a password change is NOT driven here: it signs every other session out
// (including the one all the other specs share) and changes the owner's password, so it is covered on a real database in
// tests/integration/account-actions.test.ts instead, together with a wrong current password (a failed try counts toward the sign-in lockout
// shared by every spec, so it is not driven here either). Here: the page, the sessions list, and the refusals the form gives before checking the password.
async function open(page: Page) {
  await page.goto("/settings/account");
  await page.waitForLoadState("networkidle"); // client form: act only after hydration
  await expect(page.getByRole("heading", { level: 1, name: "Account" })).toBeVisible();
}

test("a visitor without a session sees no account content", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  try {
    await page.goto("/settings/account");
    await page.waitForURL(/\/login/);
    await expect(page.getByText("Change password")).toHaveCount(0);
    await expect(page.getByTestId("sessions")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("shows who is signed in and marks this device in the list of sign-ins", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("owner-name")).not.toHaveText("");
  await expect(page.getByTestId("session-row").filter({ hasText: "This device" })).toHaveCount(1);
  await expect(page.getByRole("link", { name: "Account" }).or(page.getByRole("button", { name: "Account" })).first()).toBeVisible();
});

test("the form tells the owner what is wrong before sending anything", async ({ page }) => {
  await open(page);
  const fill = async (current: string, next: string, again: string) => {
    await page.getByLabel("Current password").fill(current);
    await page.getByLabel("New password", { exact: true }).fill(next);
    await page.getByLabel("New password again").fill(again);
    await page.getByRole("button", { name: "Change password" }).click();
  };
  await fill("some current password", "a perfectly fine passphrase 1", "a different passphrase 2");
  await expect(page.getByText("The two new passwords are not the same.")).toBeVisible();
  await fill("some current password", "short", "short");
  await expect(page.getByText("Use at least 12 characters.")).toBeVisible();
  await fill("some current password", "password1234", "password1234");
  await expect(page.getByText(/too common/)).toBeVisible();
  // what was typed is never shown back
  await expect(page.getByText("a perfectly fine passphrase 1")).toHaveCount(0);
});

test("fits a phone: no sideways scroll", async ({ page }) => {
  await open(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
