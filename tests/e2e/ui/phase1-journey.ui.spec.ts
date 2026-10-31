import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, request as pwRequest, test, type Browser, type Page } from "@playwright/test";
import pg from "pg";
import { SESSION_COOKIE, SESSION_MAX_AGE_S } from "@/lib/auth/session-cookie";
import { totpCode } from "@/server/core/totp";
import { makeKeyring } from "@/server/core/vault-crypto";
import { login } from "@/server/db/auth";
import { audit, consumeSetupLink, createSetupLink } from "@/server/db/owner";
import { beginTotpEnrollment, enableTotp, setTotpKeyring } from "@/server/db/totp";
import { routeTable } from "../../support/route-table";
import { OWNER_PASSWORD, OWNER_USERNAME, SEED_IP, STORAGE_STATE } from "../fixtures/owner";

// PHASE 1 EXIT PROOF. One story, start to finish, as the owner would live it: get the setup link, choose a password, sign in,
// turn on two-step sign-in, sign out and back in with a code, add a key, add and route a model, enter the Google app, allow a
// local service, then read it all back in the audit log, check the server really runs as the least-privilege database role,
// and knock on every route without a session.
//
// The e2e database already holds the seeded owner, which every other spec signs in as, so the "create" link cannot be issued
// here. The reset link is the same code path (the same createSetupLink the `npm run owner:reset` command calls; the setup page and
// the password rules are identical). The test puts the seeded owner back afterwards and rewrites the shared session file, because
// a reset ends every session. Desktop only: the phone project would repeat the same story.
// Throwaway strings only: Playwright records what fill() types in traces and videos.
const NEW_PASSWORD = "journey-password-for-e2e-9!";
const KEY = "sk-ant-api03-JOURNEY-SPEC-KEY-NEVER-SHOWN-4d5e6f7g";
const uid = Math.random().toString(36).slice(2, 8);

let db: pg.Pool;
test.beforeAll(() => {
  db = new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 3 });
  setTotpKeyring(() => makeKeyring(process.env.E2E_VAULT_MASTER_KEY!));
});
test.afterAll(async () => {
  setTotpKeyring(null);
  await db.end();
});

// A unique forwarded address so this story's sign-ins never share a lockout with another spec (TRUST_PROXY=1 in the e2e server).
async function fresh(browser: Browser) {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, extraHTTPHeaders: { "x-forwarded-for": "203.0.113.77" } });
  return { context, page: await context.newPage() };
}
async function signIn(page: Page, password: string, code?: string) {
  await page.waitForLoadState("networkidle"); // controlled inputs: typing before hydration would be overwritten
  await page.getByLabel("Username").fill(OWNER_USERNAME);
  await page.getByLabel("Password").fill(password);
  if (code) await page.getByLabel("Authentication or recovery code").fill(code);
  await page.getByRole("button", { name: "Sign in" }).click();
}
async function signOut(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
}

// Puts the world back the way global-setup left it: the seeded owner and password, no two-step sign-in, and a fresh session in
// the shared storage-state file (reading it happens when each test's context is created).
async function restoreSeededOwner() {
  const link = await createSetupLink(db, "reset", "http://127.0.0.1");
  const done = await consumeSetupLink(db, link.slice(link.lastIndexOf("/") + 1), { username: OWNER_USERNAME, password: OWNER_PASSWORD });
  if (!done.ok) throw new Error(`could not restore the e2e owner: ${done.reason}`);
  const session = await login(db, { username: OWNER_USERNAME, password: OWNER_PASSWORD, ip: SEED_IP, userAgent: "e2e-restore" });
  if (!session.ok) throw new Error(`could not sign the e2e owner back in: ${session.reason}`);
  await mkdir(path.dirname(STORAGE_STATE), { recursive: true });
  await writeFile(
    STORAGE_STATE,
    JSON.stringify({
      cookies: [
        { name: SESSION_COOKIE, value: session.token, domain: "127.0.0.1", path: "/", expires: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_S, httpOnly: true, secure: false, sameSite: "Lax" },
      ],
      origins: [],
    }),
    { mode: 0o600 },
  );
}

test("Phase 1 journey: from setup link to a fully configured, audited studio", async ({ browser, baseURL }, info) => {
  test.skip(info.project.name !== "ui-desktop", "one run of the story is enough");
  test.setTimeout(180_000);
  const { context, page } = await fresh(browser);
  try {
    // 1. the setup link, exactly as the command prints it, and choosing a password
    const link = await createSetupLink(db, "reset", baseURL!);
    await audit(db, "owner.reset_link", { sessionsRevoked: 0 });
    expect(new URL(link).pathname).toMatch(/^\/setup\/.+/);
    await page.goto(link);
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Username").fill(OWNER_USERNAME);
    await page.getByLabel("Password (12+ characters)").fill(NEW_PASSWORD);
    await page.getByLabel("Repeat password").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Create owner account" }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto(link); // a used link is dead
    await expect(page.getByText("This link is invalid or has expired.")).toBeVisible();

    // 2. sign in
    await page.goto("/login");
    await signIn(page, NEW_PASSWORD);
    await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();

    // 3. optional two-step sign-in. There is no enrol screen until a later phase, so it is switched on through the same
    // functions the screen will call. Then sign out and come back with a code.
    const { secret } = await beginTotpEnrollment(db);
    const enabled = await enableTotp(db, totpCode(secret, Date.now()));
    expect(enabled.ok).toBe(true);
    await signOut(page);
    await page.goto("/login");
    await signIn(page, NEW_PASSWORD);
    await expect(page.getByLabel("Authentication or recovery code")).toBeVisible(); // password alone is not enough now
    await signIn(page, NEW_PASSWORD, totpCode(secret, Date.now() + 30_000)); // the next 30 s step: this step was used to enrol
    await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();

    // 4. an Anthropic key. The Test button talks to the real provider with a fake key, so it runs only off CI.
    await page.goto("/settings/keys");
    await page.waitForLoadState("networkidle");
    const a = page.locator("li[data-provider]", { has: page.getByRole("heading", { name: "Anthropic" }) });
    if (await a.getByRole("button", { name: "Remove Anthropic key" }).count()) {
      await a.getByRole("button", { name: "Remove Anthropic key" }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Remove key" }).click();
      await expect(a.getByText("Not set")).toBeVisible();
    }
    await a.getByLabel("Anthropic API key").fill(KEY);
    await a.getByRole("button", { name: "Save key" }).click();
    await expect(a.getByText(`•••• ${KEY.slice(-4)}`)).toBeVisible();
    const testedKey = !process.env.CI;
    if (testedKey) {
      await a.getByRole("button", { name: "Test Anthropic key" }).click();
      await expect(a.getByTestId("test-status-anthropic")).toContainText(/Works|Rejected by provider|Could not reach/, { timeout: 20_000 });
    }

    // 5. a model with prices, then route a stage to it
    await page.goto("/settings/models");
    await page.waitForLoadState("networkidle");
    await page.getByText("Add a model", { exact: true }).click();
    const form = page.getByRole("form", { name: "Add a model" });
    await form.getByLabel("Model id").fill(`journey-${uid}`);
    await form.getByLabel("Name in this app").fill(`Journey ${uid}`);
    await form.getByLabel("Input", { exact: true }).fill("3.00");
    await form.getByLabel("Output", { exact: true }).fill("15.00");
    await form.getByLabel("Enabled").check();
    await form.getByRole("button", { name: "Add model" }).click();
    await expect(page.getByRole("heading", { name: `Journey ${uid}` })).toBeVisible();
    const outline = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Outline", exact: true }) });
    await outline.getByRole("combobox").selectOption(`Journey ${uid} (anthropic)`);
    await outline.getByRole("button", { name: "Use" }).click();
    await expect(outline.getByRole("status")).toHaveText("Saved.");

    // 6. the Google app (throwaway shapes; the secret never comes back)
    const SECRET = `GOCSPX-JourneySecret${uid}Zq9xK2mP7wX`;
    await page.goto("/settings/google");
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Client ID").fill(`424242424242-journey${uid}abcdefghijklmnop.apps.googleusercontent.com`);
    await page.getByLabel("Client secret").fill(SECRET);
    await page.getByRole("button", { name: "Save to vault" }).click();
    await expect(page.getByText("Saved. The secret is in the vault")).toBeVisible();
    expect(await page.content()).not.toContain(SECRET);

    // 7. allow one local service (cleared first so the change is always a change)
    await page.goto("/settings/system");
    await page.waitForLoadState("networkidle");
    const services = page.getByLabel("Allowed local services, one per line");
    for (const text of ["", "localhost:11434"]) {
      await services.fill(text);
      await page.getByLabel(/I understand the app will be allowed/).check();
      await Promise.all([
        page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/settings/system")),
        page.getByRole("button", { name: "Save list" }).click(),
      ]);
      await expect(page.getByRole("button", { name: "Save list" })).toBeEnabled();
    }
    await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();

    // 8. the audit log shows every step
    await page.goto("/settings/audit");
    await expect(page.getByRole("heading", { level: 1, name: "Audit log" })).toBeVisible();
    const seen = await page.getByTestId("audit-row").evaluateAll((els) => els.map((e) => e.getAttribute("data-event")));
    const expected = [
      "owner.reset_link",
      "owner.reset_completed",
      "login.success",
      "totp.enabled",
      "key.set",
      ...(testedKey ? ["key.tested"] : []),
      "model.added",
      "route.changed",
      "google_app.saved",
      "setting.changed",
    ];
    for (const ev of expected) expect(seen, `the audit log should show ${ev}`).toContain(ev);
    const html = await page.content();
    for (const secretish of [KEY, SECRET, NEW_PASSWORD, secret]) expect(html).not.toContain(secretish);

    // 9. the app really runs as the least-privilege role, and that role cannot rewrite history
    expect((await db.query("select current_user u")).rows[0].u).toBe("ytstudio_app");
    const roles = (await db.query("select distinct usename from pg_stat_activity where datname = current_database() and usename is not null")).rows.map((r) => r.usename);
    expect(roles).toEqual(["ytstudio_app"]); // the running server and this check use the same role; no owner or admin connection is open
    await expect(db.query("update audit_log set event = 'x'")).rejects.toThrow(/permission denied/);
    await expect(db.query("delete from audit_log")).rejects.toThrow(/permission denied/);
  } finally {
    await context.close();
    await restoreSeededOwner();
    // leave the shared database as other specs expect it (the audit log is append-only and stays)
    await db.query("delete from llm_routes where model_id in (select id from llm_models where model_id = $1)", [`journey-${uid}`]);
    await db.query("delete from llm_models where model_id = $1", [`journey-${uid}`]);
    await db.query("delete from secrets where name like 'provider.%' or name like 'google.%'");
    await db.query("delete from google_apps");
  }

  // 10. every route in the app, with no session at all, is refused (pages go to /login, API routes answer 401)
  // an empty storage state on purpose: a bare request context inside a ui project would otherwise inherit the owner's session
  const anon = await pwRequest.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  try {
    for (const r of routeTable().filter((x) => !x.isPublic && x.methods.includes("GET"))) {
      const res = await anon.get(r.url, { maxRedirects: 0 });
      const body = await res.text();
      const refused = r.kind === "route" ? res.status() === 401 : res.status() === 307 || (res.status() === 200 && body.includes("NEXT_REDIRECT;replace;/login;307;"));
      expect(refused, `${r.url} answered ${res.status()} without a session`).toBe(true);
    }
  } finally {
    await anon.dispose();
  }
});
