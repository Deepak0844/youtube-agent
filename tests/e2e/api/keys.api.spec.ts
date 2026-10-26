import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { endSessionPool, mintSession, revokeSession } from "../fixtures/sessions";

const port = process.env.E2E_PORT!;
const ORIGIN = `http://127.0.0.1:${port}`;
const KEY = "sk-ant-api03-API-SPEC-KEY-MUST-NOT-STICK-1a2b3c4d";

let db: pg.Pool;
test.beforeAll(() => {
  db = new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 2 });
});
test.afterAll(async () => {
  await db.end();
  await endSessionPool();
});

function actionId(name: string): string {
  const m = JSON.parse(readFileSync(".next/server/server-reference-manifest.json", "utf8")) as { node: Record<string, { exportedName: string; workers: Record<string, unknown> }> };
  const hit = Object.entries(m.node).find(([, v]) => v.exportedName === name && Object.keys(v.workers).some((w) => w.includes("settings/keys")));
  if (!hit) throw new Error(`server action ${name} not found in the build manifest`);
  return hit[0];
}
const stored = async () => (await db.query("select count(*)::int n from secrets where name like 'provider.%'")).rows[0].n as number;
const post = (request: import("@playwright/test").APIRequestContext, name: string, headers: Record<string, string>) =>
  request.post("/settings/keys", {
    maxRedirects: 0,
    headers,
    multipart: { [`$ACTION_ID_${actionId(name)}`]: "", provider: "anthropic", value: KEY },
  });

test("the page is refused without a session (redirect to login, no content)", async ({ request }) => {
  const res = await request.get("/settings/keys", { maxRedirects: 0 });
  expect(res.status()).toBe(307);
  expect(res.headers().location).toContain("/login");
  expect(await res.text()).not.toContain("Vault");
});

test("each server action is refused without a session and stores nothing", async ({ request }) => {
  const before = await stored();
  for (const name of ["setKeyAction", "testKeyAction", "removeKeyAction"]) {
    const res = await post(request, name, { origin: ORIGIN });
    expect([307, 401], name).toContain(res.status());
    expect(await res.text()).not.toContain(KEY);
  }
  expect(await stored()).toBe(before);
});

test("an ended session cannot run the actions (the cookie is checked for real)", async ({ request }) => {
  const token = await mintSession();
  await revokeSession(token);
  const before = await stored();
  const audits = async () => (await db.query("select count(*)::int n from audit_log where event = 'key.set'")).rows[0].n as number;
  const auditsBefore = await audits();
  const res = await post(request, "setKeyAction", { origin: ORIGIN, cookie: `ytstudio_session=${token}` });
  const body = await res.text();
  expect(body).not.toContain(KEY);
  expect(body).not.toContain("Saved.");
  expect(await stored()).toBe(before);
  expect(await audits()).toBe(auditsBefore);
});

test("a foreign origin is refused even with a valid session", async ({ request }) => {
  const token = await mintSession();
  const before = await stored();
  const res = await post(request, "setKeyAction", { origin: "http://evil.test", cookie: `ytstudio_session=${token}` });
  expect(await res.text()).not.toContain("Saved.");
  expect(await stored()).toBe(before);
});
