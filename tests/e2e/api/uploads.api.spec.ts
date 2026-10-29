import { randomUUID } from "node:crypto";
import { expect, request, test } from "@playwright/test";
import { endSessionPool, mintSession } from "../fixtures/sessions";

const port = process.env.E2E_PORT!;
const ORIGIN = `http://127.0.0.1:${port}`;
test.afterAll(endSessionPool);

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const RIGHTS = JSON.stringify({ text: "I have the rights to use this", contains_person: false, voice_clone: false });
const send = (token: string | null, data: Buffer, o: { origin?: string; batch?: string } = {}) =>
  request.newContext({ baseURL: ORIGIN }).then((ctx) =>
    ctx.post(`/api/uploads?batch=${o.batch ?? randomUUID()}`, {
      data,
      headers: { origin: o.origin ?? ORIGIN, "content-type": "application/octet-stream", "x-rights": RIGHTS, "x-file-name": encodeURIComponent("<b>cat.png"), ...(token && { cookie: `ytstudio_session=${token}` }) },
      timeout: 120_000,
    }),
  );

test("unauthenticated upload is refused before the body is read", async () => {
  expect((await send(null, PNG)).status()).toBe(401);
});

test("wrong origin is refused (with a valid session)", async () => {
  expect((await send(await mintSession(), PNG, { origin: "http://evil.test" })).status()).toBe(403);
});

test("a small image is accepted and queued, and its status needs a session", async () => {
  const token = await mintSession();
  const res = await send(token, PNG);
  expect(res.status()).toBe(201);
  const { id, status } = await res.json();
  expect(status).toBe("queued");
  const ctx = await request.newContext({ baseURL: ORIGIN });
  expect((await ctx.get(`/api/uploads/${id}`)).status()).toBe(401);
  const seen = await ctx.get(`/api/uploads/${id}`, { headers: { cookie: `ytstudio_session=${token}` } });
  expect(seen.status()).toBe(200);
  const j = await seen.json();
  expect(j.status).toBe("queued"); // no worker in the e2e run
  expect(j.name).toBe("&lt;b&gt;cat.png"); // escaped on display
});

test("an HTML file is refused by its first bytes, whatever its name says", async () => {
  const res = await send(await mintSession(), Buffer.from("<html><script>alert(1)</script></html>"));
  expect(res.status()).toBe(415);
});

test("an image over the image limit is cut off with 413", async () => {
  const body = Buffer.concat([PNG, Buffer.alloc(26 * 1024 * 1024)]);
  expect((await send(await mintSession(), body)).status()).toBe(413);
});

test("responses carry the CSP and nosniff", async ({ request }) => {
  const res = await request.get("/login");
  const csp = res.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain("unsafe-eval"); // production build
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
});
