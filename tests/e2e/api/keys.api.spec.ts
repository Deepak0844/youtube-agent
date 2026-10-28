import { readFileSync } from "node:fs";
import { expect, test, type APIRequestContext } from "@playwright/test";
import pg from "pg";
import { makeKeyring } from "@/server/core/vault-crypto";
import { putSecret } from "@/server/db/vault";
import { endSessionPool, expireSession, mintSession, revokeSession } from "../fixtures/sessions";

// NOTE: failure artifacts (traces, screenshots, videos) record what specs type. Specs use throwaway strings only, never a real key.
const port = process.env.E2E_PORT!;
const ORIGIN = `http://127.0.0.1:${port}`;
const KEY = "sk-ant-api03-API-SPEC-KEY-MUST-NOT-STICK-1a2b3c4d";
const SEEDED = "sk-proj-API-SPEC-SEEDED-KEY-STAYS-PUT-0z9y8x7w";
const SEEDED_NAME = "provider.openai.api_key";

let db: pg.Pool;
test.beforeAll(() => {
  db = new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 2 });
});
test.afterAll(async () => {
  await db.end();
  await endSessionPool();
});
// A real, readable secret, so an action that wrongly ran would visibly change or use it.
test.beforeEach(async () => {
  // The e2e database can be reused by focused Playwright runs; isolate this spec from signing/OAuth keys those runs made.
  await db.query("delete from secrets");
  await putSecret(db, makeKeyring(process.env.E2E_VAULT_MASTER_KEY!), SEEDED_NAME, SEEDED);
});
test.afterEach(async () => {
  await db.query("delete from secrets where name like 'provider.%'");
});

function actionId(name: string): string {
  const m = JSON.parse(readFileSync(".next/server/server-reference-manifest.json", "utf8")) as { node: Record<string, { exportedName: string; workers: Record<string, unknown> }> };
  const hit = Object.entries(m.node).find(([, v]) => v.exportedName === name && Object.keys(v.workers).some((w) => w.includes("settings/keys")));
  if (!hit) throw new Error(`server action ${name} not found in the build manifest`);
  return hit[0];
}
const snapshot = async () => ({
  secrets: (await db.query("select name, hint, updated_at, encode(ciphertext, 'hex') c from secrets order by name")).rows,
  audits: (await db.query("select count(*)::int n from audit_log where event in ('key.set', 'key.removed', 'key.tested')")).rows[0].n as number,
});
// Calls a Server Action the way the browser does: Next-Action header plus a React "reply" body (args [prevState, FormData]).
// Without this the POST would not reach the action at all, and "refused" would prove nothing (see the positive control below).
const post = (request: APIRequestContext, name: string, headers: Record<string, string>, provider = "openai") => {
  const boundary = "----ytstudioE2eBoundary";
  const part = (n: string, v: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`;
  const body = part("_1_provider", provider) + part("_1_value", KEY) + part("0", JSON.stringify([{}, "$K1"])) + `--${boundary}--\r\n`;
  return request.post("/settings/keys", {
    maxRedirects: 0,
    headers: { "next-action": actionId(name), accept: "text/x-component", "content-type": `multipart/form-data; boundary=${boundary}`, ...headers },
    data: Buffer.from(body),
  });
};

test("positive control: the same request with a valid session really runs the action", async ({ request }) => {
  const token = await mintSession();
  const before = await snapshot();
  expect(before.secrets).toHaveLength(1);
  const res = await post(request, "removeKeyAction", { origin: ORIGIN, cookie: `ytstudio_session=${token}` });
  expect(res.status()).toBe(200);
  const after = await snapshot();
  expect(after.secrets).toHaveLength(0);
  expect(after.audits).toBe(before.audits + 1);
});

test("the page is refused without a session (redirect to login, no content)", async ({ request }) => {
  const res = await request.get("/settings/keys", { maxRedirects: 0 });
  expect(res.status()).toBe(307);
  expect(res.headers().location).toContain("/login");
  expect(await res.text()).not.toContain("Vault");
});

const ACTIONS = ["setKeyAction", "removeKeyAction", "testKeyAction"];
const SESSIONS: Array<[string, () => Promise<string | null>]> = [
  ["no cookie", async () => null],
  ["a revoked cookie", async () => (async (t) => (await revokeSession(t), t))(await mintSession())],
  ["an expired cookie", async () => (async (t) => (await expireSession(t), t))(await mintSession())],
];

for (const [label, make] of SESSIONS) {
  for (const name of ACTIONS) {
    test(`${name} with ${label} changes nothing (seeded key and audit log untouched)`, async ({ request }) => {
      const before = await snapshot();
      const token = await make();
      const res = await post(request, name, { origin: ORIGIN, ...(token ? { cookie: `ytstudio_session=${token}` } : {}) });
      const body = await res.text();
      expect(body).not.toContain(KEY);
      expect(body).not.toContain(SEEDED);
      expect(body).not.toContain("Saved.");
      expect(body).not.toContain("Removed.");
      expect(await snapshot()).toEqual(before);
    });
  }
}

test("a foreign origin is refused even with a valid session", async ({ request }) => {
  const token = await mintSession();
  const before = await snapshot();
  const res = await post(request, "setKeyAction", { origin: "http://evil.test", cookie: `ytstudio_session=${token}` });
  expect(await res.text()).not.toContain("Saved.");
  expect(await snapshot()).toEqual(before);
});

// FINDING (documented, not a bug in this page): Next's built-in check compares Origin to Host only WHEN an Origin header is
// present. A POST with a valid session and no Origin at all is run. Browsers always send Origin on cross-site POSTs and the
// session cookie is SameSite=Lax, so this is not a browser CSRF path; it needs the stolen cookie itself. Without a session
// it is refused, which is what we assert here.
test("a forged POST with no Origin header and no session stores nothing", async ({ request }) => {
  const before = await snapshot();
  const res = await post(request, "setKeyAction", {}, "anthropic");
  expect(await res.text()).not.toContain("Saved.");
  expect(await snapshot()).toEqual(before);
});
