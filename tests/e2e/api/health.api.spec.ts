import { expect, test } from "@playwright/test";

test("healthz is ok and reveals nothing else", async ({ request }) => {
  const res = await request.get("/healthz");
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

test("unknown route is 404", async ({ request }) => {
  const res = await request.get("/nope");
  expect(res.status()).toBe(404);
});
