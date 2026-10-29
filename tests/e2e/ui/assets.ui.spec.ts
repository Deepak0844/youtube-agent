import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { endSessionPool } from "../fixtures/sessions";

// Runs with the seeded owner's session at 1440 and 390 wide. There is no worker in the e2e run, so a finished upload is
// played by inserting the asset row; uploads themselves are checked up to "waiting to be checked". The database is shared
// across specs, so every test uses its own unique tag and looks only at its own cards.
const FX = path.join(process.cwd(), "tests/fixtures/assets");
let db: pg.Pool;
test.beforeAll(() => {
  db = new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 2 });
});
test.afterAll(async () => {
  await db.end();
  await endSessionPool();
});

async function seed(tag: string, o: { kind?: "image" | "audio"; name?: string; keep?: boolean } = {}): Promise<string> {
  const kind = o.kind ?? "image";
  const id = randomUUID();
  const rights = JSON.stringify({ attestations: [{ at: new Date().toISOString(), text: "I have the rights to use this" }] });
  await db.query(
    `insert into assets (id, kind, original_name, mime, bytes, sha256, storage_ref, tags, source, rights, keep)
     values ($1,$2,$3,$4,10,$5,$6,$7::text[],'upload',$8::jsonb,$9)`,
    [id, kind, o.name ?? `${tag}.png`, kind === "image" ? "image/png" : "audio/wav", createHash("sha256").update(id).digest("hex"), `assets/${id}/main.${kind === "image" ? "png" : "wav"}`, [tag], rights, o.keep ?? false],
  );
  return id;
}
const card = (page: Page, name: string) => page.locator("li[data-asset]", { hasText: name });
async function open(page: Page, query = "") {
  await page.goto(`/assets${query}`);
  await page.waitForLoadState("networkidle"); // client components: act only after hydration
  await expect(page.getByRole("heading", { level: 1, name: "Assets" })).toBeVisible();
}

test("a visitor without a session sees no asset content", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  try {
    await page.goto("/assets");
    await page.waitForURL(/\/login/);
    await expect(page.getByText("I have the rights to use this")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("cards show, filters narrow them, no sideways scroll", async ({ page }) => {
  const tag = `t${Date.now()}a`;
  await seed(tag, { name: `${tag}-photo.png` });
  await seed(tag, { kind: "audio", name: `${tag}-tone.wav` });
  await open(page, `?tag=${tag}`);
  await expect(page.locator("li[data-asset]")).toHaveCount(2);
  await open(page, `?tag=${tag}&kind=audio`);
  await expect(page.locator("li[data-asset]")).toHaveCount(1);
  await expect(card(page, `${tag}-tone.wav`)).toBeVisible();
  await open(page, `?tag=${tag}&q=photo`);
  await expect(page.locator("li[data-asset]")).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("an empty result says what to do in trade words", async ({ page }) => {
  await open(page, `?tag=nothing-${Date.now()}`);
  await expect(page.getByText("Nothing here yet. Drop some photos or sound files here to use them in a video.")).toBeVisible();
});

test("upload needs the rights tick, then queues each file", async ({ page }) => {
  await open(page);
  const input = page.locator('input[type="file"]');
  await input.setInputFiles([path.join(FX, "plain.png"), path.join(FX, "tone.wav")]);
  const send = page.getByRole("button", { name: "Upload" });
  await expect(send).toBeDisabled();
  await page.getByLabel("I have the rights to use this").check();
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.getByText("Waiting to be checked")).toHaveCount(2);
  const jobs = await db.query("select count(*)::int n from ingest_jobs where original_name in ('plain.png','tone.wav') and status = 'queued'");
  expect(jobs.rows[0].n).toBeGreaterThanOrEqual(2);
});

test("a person photo needs the consent tick before sending", async ({ page }) => {
  await open(page);
  await page.locator('input[type="file"]').setInputFiles(path.join(FX, "plain.png"));
  await page.getByLabel("I have the rights to use this").check();
  await page.getByLabel("A person is in it").check();
  await expect(page.getByRole("button", { name: "Upload" })).toBeDisabled();
  await page.getByLabel("They agreed to be shown").check();
  await expect(page.getByRole("button", { name: "Upload" })).toBeEnabled();
});

test("HEIC is refused with the convert message", async ({ page }) => {
  await open(page);
  await page.locator('input[type="file"]').setInputFiles(path.join(FX, "photo.heic"));
  await expect(page.getByText("Convert the photo to JPEG or PNG and upload again.")).toBeVisible();
});

test("Keep asks again before delete; delete goes to the trash and restores", async ({ page }) => {
  const tag = `t${Date.now()}b`;
  const id = await seed(tag, { name: `${tag}-keep.png` });
  await page.goto(`/assets/${id}`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("switch", { name: "Keep" }).click();
  await expect(page.getByRole("switch", { name: "Keep" })).toBeChecked();
  expect((await db.query("select keep from assets where id = $1", [id])).rows[0].keep).toBe(true);

  await open(page, `?tag=${tag}`);
  await card(page, `${tag}-keep.png`).getByRole("checkbox").check();
  await page.getByRole("button", { name: "Delete selected" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("marked Keep");
  await page.getByRole("alertdialog").getByRole("button", { name: "Move to trash" }).click();
  await expect(page.locator("li[data-asset]")).toHaveCount(0);
  const r = await db.query("select deleted_at, purge_at from assets where id = $1", [id]);
  expect(r.rows[0].purge_at.getTime() - r.rows[0].deleted_at.getTime()).toBeGreaterThan(6.9 * 86400_000);

  await open(page, `?tag=${tag}&trash=1`);
  await card(page, `${tag}-keep.png`).getByRole("button", { name: "Restore" }).click();
  await expect(page.locator("li[data-asset]")).toHaveCount(0);
  expect((await db.query("select deleted_at from assets where id = $1", [id])).rows[0].deleted_at).toBeNull();
  const ev = await db.query("select event from audit_log where event in ('asset.kept','asset.deleted','asset.restored') order by id desc limit 3");
  expect(ev.rows.map((x) => x.event).sort()).toEqual(["asset.deleted", "asset.kept", "asset.restored"]);
});

test("bulk tag adds a tag to the chosen cards", async ({ page }) => {
  const tag = `t${Date.now()}c`;
  const id = await seed(tag, { name: `${tag}-x.png` });
  await open(page, `?tag=${tag}`);
  await card(page, `${tag}-x.png`).getByRole("checkbox").check();
  await page.getByLabel("Tag to add").fill("beach");
  await page.getByRole("button", { name: "Add tag" }).click();
  await expect(card(page, `${tag}-x.png`)).toContainText("beach");
  expect((await db.query("select tags from assets where id = $1", [id])).rows[0].tags).toContain("beach");
});
