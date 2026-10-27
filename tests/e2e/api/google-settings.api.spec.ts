import { expect, test } from "@playwright/test";

const ORIGIN = `http://127.0.0.1:${process.env.E2E_PORT}`;

test("without a session /settings/google redirects to login", async ({ request }) => {
  const res = await request.get("/settings/google", { maxRedirects: 0 });
  expect([302, 303, 307, 308]).toContain(res.status());
  expect(res.headers().location).toContain("/login");
});

test("a forged server-action POST without a session never saves and never succeeds", async ({ request }) => {
  const res = await request.post("/settings/google", {
    headers: { origin: ORIGIN, "next-action": "0000000000000000000000000000000000000000ff", "content-type": "text/plain;charset=UTF-8" },
    data: JSON.stringify([{}, "x"]),
    maxRedirects: 0,
  });
  expect(res.status()).not.toBe(200);
  expect(await res.text()).not.toContain("Saved");
});

test("the OAuth callback path is not an API for this page (no handler yet)", async ({ request }) => {
  const res = await request.get("/api/oauth/google/callback", { maxRedirects: 0 });
  expect([401, 404]).toContain(res.status());
});
