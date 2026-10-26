import { expect, test } from "@playwright/test";
import { endSessionPool, mintSession } from "../fixtures/sessions";

test("healthz is ok and reveals nothing else", async ({ request }) => {
  const res = await request.get("/healthz");
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

test("unknown route is 404 for the owner and a login redirect for everyone else", async ({ request }) => {
  const anon = await request.get("/nope", { maxRedirects: 0 });
  expect(anon.status()).toBe(307);
  const token = await mintSession();
  const res = await request.get("/nope", { headers: { cookie: `ytstudio_session=${token}` } });
  expect(res.status()).toBe(404);
});

test.afterAll(endSessionPool);
