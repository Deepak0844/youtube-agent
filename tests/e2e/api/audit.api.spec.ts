import { expect, test } from "@playwright/test";
import pg from "pg";
import { insertAudit } from "@/server/db/audit";
import { endSessionPool, expireSession, mintSession, revokeSession } from "../fixtures/sessions";

// /settings/audit is a read-only page with two query parameters and no action or API route. The derived
// session-required spec already runs the full refusal matrix over it; these cases add what is specific to the log:
// a refusal never carries log content, even with hostile query values, and a hostile query with a session never errors.
const MARK = `api-audit-marker-${Date.now()}`;
let db: pg.Pool;
test.beforeAll(async () => {
  db = new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 1 });
  await insertAudit(db, "setting.changed", { marker: MARK });
});
test.afterAll(async () => {
  await db.end();
  await endSessionPool();
});

const QUERIES = ["", "?before=1", "?event=login", "?before=abc&event=%25", "?before=1;drop%20table%20audit_log", "?before=" + "9".repeat(60)];

for (const q of QUERIES) {
  test(`anonymous GET /settings/audit${q.slice(0, 30)} is sent to login with no log content`, async ({ request }) => {
    const res = await request.get(`/settings/audit${q}`, { maxRedirects: 0 });
    expect(res.status()).toBe(307);
    expect(new URL(res.headers().location!, "http://x").pathname).toBe("/login");
    expect(await res.text()).not.toContain(MARK);
  });
}

test("revoked and expired sessions are refused and see no log content", async ({ request }) => {
  for (const kill of [revokeSession, expireSession]) {
    const token = await mintSession();
    await kill(token);
    const res = await request.get("/settings/audit", { maxRedirects: 0, headers: { cookie: `ytstudio_session=${token}` } });
    const body = await res.text();
    expect(body).not.toContain(MARK);
    expect(res.status() === 307 || body.includes("NEXT_REDIRECT;replace;/login;307;")).toBe(true);
  }
});

test("with a session, hostile query values still answer 200 with the page and no error text", async ({ request }) => {
  const token = await mintSession();
  for (const q of QUERIES) {
    const res = await request.get(`/settings/audit${q}`, { maxRedirects: 0, headers: { cookie: `ytstudio_session=${token}` } });
    expect(res.status(), q).toBe(200);
    const body = await res.text();
    expect(body, q).toContain("Audit log");
    expect(body, q).not.toMatch(/invalid cursor|syntax error|stack|NEXT_REDIRECT/i);
  }
});

test("with a session the page shows the newest entries and keeps secrets out of the markup", async ({ request }) => {
  const token = await mintSession();
  const res = await request.get("/settings/audit", { headers: { cookie: `ytstudio_session=${token}` } });
  const body = await res.text();
  expect(body).toContain(MARK);
  expect(body).not.toMatch(/postgres:\/\/|redis:\/\/|e2e-app-pw|e2e-owner-pw|dangerouslySetInnerHTML/);
});
