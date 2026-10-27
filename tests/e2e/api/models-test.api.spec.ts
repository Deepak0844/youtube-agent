import { expect, test } from "@playwright/test";

const ORIGIN = `http://127.0.0.1:${process.env.E2E_PORT!}`;

// The Test button is a server action on /settings/models (no JSON API). It can spend money, so anonymous, forged and
// token-style callers must never reach it: they get no 200, no catalog content and no model call.
test("test_is_session_only: a Test action POST without a session does not run", async ({ request }) => {
  const res = await request.post("/settings/models", {
    maxRedirects: 0,
    headers: { origin: ORIGIN, "next-action": "0000000000000000000000000000000000000000", "content-type": "text/plain;charset=UTF-8" },
    data: '["$undefined",{"rowId":"00000000-0000-4000-8000-000000000001"}]',
  });
  expect(res.status()).not.toBe(200);
  const body = await res.text();
  expect(body).not.toContain("Answered in");
  expect(body).not.toContain("Structured JSON");
});

test("test_is_session_only: a bearer token cannot reach the page or any test endpoint", async ({ request }) => {
  for (const path of ["/settings/models", "/api/models/test", "/api/llm/test"]) {
    const res = await request.post(path, { maxRedirects: 0, headers: { authorization: "Bearer yts_forged_token_forged_token_forged_token_0000", origin: ORIGIN }, data: {} });
    expect([307, 308, 401, 403, 404, 405]).toContain(res.status());
    expect(await res.text()).not.toContain("Answered in");
  }
});

test("a forged session cookie cannot trigger a test", async ({ request }) => {
  const res = await request.post("/settings/models", {
    maxRedirects: 0,
    headers: { origin: ORIGIN, cookie: "ytstudio_session=forged-forged-forged-forged-forged-0123456789", "next-action": "0000000000000000000000000000000000000000", "content-type": "text/plain;charset=UTF-8" },
    data: "[]",
  });
  expect(res.status()).not.toBe(200);
  expect(await res.text()).not.toContain("Answered in");
});
