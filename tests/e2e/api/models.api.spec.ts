import { expect, test } from "@playwright/test";

const ORIGIN = `http://127.0.0.1:${process.env.E2E_PORT!}`;

// The models page has no JSON API; its only entry points are the page and its server actions. Without a real session
// neither may answer with catalog data or run an action.
test("unauthenticated visit to /settings/models is sent to /login", async ({ request }) => {
  const res = await request.get("/settings/models", { maxRedirects: 0 });
  expect(res.status()).toBe(307);
  expect(res.headers().location).toContain("/login");
});

test("a forged session cookie is not a session", async ({ request }) => {
  const res = await request.get("/settings/models", { maxRedirects: 0, headers: { cookie: "ytstudio_session=forged-forged-forged-forged-forged-0123456789" } });
  // The proxy only checks that a cookie exists; the real check runs in the page inside <Suspense>, so the static shell
  // may already be streaming as 200 and the redirect travels in the stream. What matters: no catalog content.
  const body = await res.text();
  expect([200, 307]).toContain(res.status());
  for (const word of ["Stage routing", "Add a model", "Suggestions"]) expect(body).not.toContain(word);
  if (res.status() === 200) expect(body).toContain("NEXT_REDIRECT");
});

test("a server action POST without a session does not run", async ({ request }) => {
  const res = await request.post("/settings/models", {
    maxRedirects: 0,
    headers: { origin: ORIGIN, "next-action": "0000000000000000000000000000000000000000", "content-type": "text/plain;charset=UTF-8" },
    data: "[]",
  });
  expect(res.status()).not.toBe(200);
  expect(await res.text()).not.toContain("Stage routing");
});
