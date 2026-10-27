import { expect, test } from "@playwright/test";

const ORIGIN = `http://127.0.0.1:${process.env.E2E_PORT}`;

// "no session -> login" for this page comes from the derived session-required spec.
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
