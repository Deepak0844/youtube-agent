import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import pg from "pg";
import { makeKeyring } from "@/server/core/vault-crypto";
import { getOwnGoogleApp, saveOwnGoogleApp } from "@/server/db/google-app";
import { getSecret } from "@/server/db/vault";
import { endSessionPool, expireSession, mintSession, revokeSession } from "../fixtures/sessions";

// NOTE: Playwright traces, screenshots and videos record what specs type (fill() values). Use throwaway strings only,
// never a real Google client secret.
//
// "No session -> login" for the page itself comes from the derived session-required spec. These cases call the REAL
// server actions (ids read from the build manifest, args shaped like the browser's), so "refused" proves requireOwner ran
// before anything else: a made-up action id would be rejected by Next itself and prove nothing.
const ORIGIN = `http://127.0.0.1:${process.env.E2E_PORT}`;
const ring = makeKeyring(process.env.E2E_VAULT_MASTER_KEY!);
const SEED_ID = "111111111111-seededclientidstays.apps.googleusercontent.com";
const SEED_SECRET = "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-PUT";
const NEW_ID = "222222222222-attackerclientidmuststay.apps.googleusercontent.com";
const NEW_SECRET = "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-STICK";

let db: pg.Pool;
test.beforeAll(() => {
  db = new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 2 });
});
test.afterAll(async () => {
  await db.end();
  await endSessionPool();
});
test.beforeEach(async () => {
  await db.query("delete from google_apps");
  await db.query("delete from secrets where name like 'google.%'");
  expect(await saveOwnGoogleApp(db, ring, { clientId: SEED_ID, clientSecret: SEED_SECRET })).toEqual({ ok: true });
});
test.afterEach(async () => {
  await db.query("delete from google_apps");
  await db.query("delete from secrets where name like 'google.%'");
});

function actionId(name: string): string {
  const m = JSON.parse(readFileSync(".next/server/server-reference-manifest.json", "utf8")) as { node: Record<string, { exportedName: string; workers: Record<string, unknown> }> };
  const hit = Object.entries(m.node).find(([, v]) => v.exportedName === name && Object.keys(v.workers).some((w) => w.includes("settings/google")));
  if (!hit) throw new Error(`server action ${name} not found in the build manifest`);
  return hit[0];
}
const snapshot = async () => ({
  apps: (await db.query("select kind, client_id, client_secret_name, updated_at from google_apps order by kind")).rows,
  secrets: (await db.query("select name, hint, updated_at, encode(ciphertext, 'hex') c from secrets where name like 'google.%' order by name")).rows,
  audits: (await db.query("select count(*)::int n from audit_log where event like 'google_app.%'")).rows[0].n as number,
});

type Fields = { clientId?: string | { file: string }; clientSecret?: string };
// Calls a Server Action the way the browser does: Next-Action header plus a React "reply" body (args [prevState, FormData]).
const post = (request: APIRequestContext, name: string, headers: Record<string, string>, fields: Fields = { clientId: NEW_ID, clientSecret: NEW_SECRET }) => {
  const boundary = "----ytstudioE2eBoundary";
  const part = (n: string, v: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`;
  const file = (n: string, content: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${n}"; filename="x.txt"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n`;
  let body = "";
  if (fields.clientId !== undefined) body += typeof fields.clientId === "string" ? part("_1_clientId", fields.clientId) : file("_1_clientId", fields.clientId.file);
  if (fields.clientSecret !== undefined) body += part("_1_clientSecret", fields.clientSecret);
  body += part("0", JSON.stringify([{ status: "idle" }, "$K1"])) + `--${boundary}--\r\n`;
  return request.post("/settings/google", {
    maxRedirects: 0,
    headers: { "next-action": actionId(name), accept: "text/x-component", "content-type": `multipart/form-data; boundary=${boundary}`, ...headers },
    data: Buffer.from(body),
  });
};
const as = (token: string, extra: Record<string, string> = {}) => ({ origin: ORIGIN, cookie: `ytstudio_session=${token}`, ...extra });

test("positive control: the same request with a valid session really runs the save action", async ({ request }) => {
  const before = await snapshot();
  const res = await post(request, "saveGoogleAppAction", as(await mintSession()));
  expect(res.status()).toBe(200);
  expect(await res.text()).not.toContain(NEW_SECRET);
  const after = await snapshot();
  expect(after.audits).toBe(before.audits + 1);
  expect((await getOwnGoogleApp(db))!.clientId).toBe(NEW_ID);
  expect(await getSecret(db, ring, "google.app.client_secret")).toBe(NEW_SECRET);
});

test("positive control: the test action really runs with a valid session (one audit row, booleans only)", async ({ request }) => {
  const before = await snapshot();
  const res = await post(request, "testGoogleAppAction", as(await mintSession()));
  expect(res.status()).toBe(200);
  expect(await res.text()).not.toContain(SEED_SECRET);
  expect((await snapshot()).audits).toBe(before.audits + 1);
});

const SESSIONS: Array<[string, () => Promise<string | null>]> = [
  ["no cookie", async () => null],
  ["a garbage cookie", async () => randomBytes(32).toString("base64url")],
  ["a revoked cookie", async () => (async (t) => (await revokeSession(t), t))(await mintSession())],
  ["an expired cookie", async () => (async (t) => (await expireSession(t), t))(await mintSession())],
];
for (const [label, make] of SESSIONS) {
  for (const name of ["saveGoogleAppAction", "testGoogleAppAction"]) {
    test(`${name} with ${label} changes nothing (stored id, secret and audit log untouched)`, async ({ request }) => {
      const before = await snapshot();
      const token = await make();
      const res = await post(request, name, { origin: ORIGIN, ...(token ? { cookie: `ytstudio_session=${token}` } : {}) });
      const body = await res.text();
      for (const s of [NEW_SECRET, SEED_SECRET, "Saved."]) expect(body).not.toContain(s);
      expect(await snapshot()).toEqual(before);
    });
  }
}

test("a foreign Origin is refused even with a valid session (nothing changes)", async ({ request }) => {
  const before = await snapshot();
  for (const name of ["saveGoogleAppAction", "testGoogleAppAction"]) {
    const res = await post(request, name, as(await mintSession(), { origin: "http://evil.test" }));
    expect(await res.text()).not.toContain("Saved.");
  }
  expect(await snapshot()).toEqual(before);
});

// FINDING (documented, not a bug in this page): Next's built-in check compares Origin to Host only WHEN an Origin header is
// present. A POST with a valid session and NO Origin header at all is accepted and run. Browsers always send Origin on
// cross-site POSTs and the session cookie is SameSite=Lax, so this is not a browser CSRF path; it needs the stolen cookie
// itself. Without a session it is refused, which is what we assert here.
test("a forged POST with no Origin header and no session stores nothing", async ({ request }) => {
  const before = await snapshot();
  const res = await post(request, "saveGoogleAppAction", {});
  expect(await res.text()).not.toContain("Saved.");
  expect(await snapshot()).toEqual(before);
});

// A value over the cap must be a field error, never read as "blank, keep what is stored" with a success message.
const OVERSIZE: Array<[string, Fields]> = [
  ["a 400-char secret with a valid new id", { clientId: NEW_ID, clientSecret: "s".repeat(400) }],
  ["a 5000-char secret", { clientId: NEW_ID, clientSecret: "s".repeat(5000) }],
  ["a 400-char client id with a valid new secret", { clientId: `${"a".repeat(400)}.apps.googleusercontent.com`, clientSecret: NEW_SECRET }],
  ["a file in place of the client id", { clientId: { file: "x" }, clientSecret: NEW_SECRET }],
];
for (const [label, fields] of OVERSIZE) {
  test(`${label} is refused: no "Saved", nothing stored or audited, old secret unchanged`, async ({ request }) => {
    const before = await snapshot();
    const res = await post(request, "saveGoogleAppAction", as(await mintSession()), fields);
    const body = await res.text();
    expect(res.status()).toBe(200);
    expect(body).not.toContain("Saved.");
    expect(body).toContain('"status":"error"');
    expect(body).not.toContain(NEW_SECRET);
    expect(await snapshot()).toEqual(before);
    expect(await getSecret(db, ring, "google.app.client_secret")).toBe(SEED_SECRET);
    expect((await getOwnGoogleApp(db))!.clientId).toBe(SEED_ID);
  });
}
