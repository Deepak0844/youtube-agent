import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { endSessionPool, mintSession } from "../fixtures/sessions";

const port = process.env.E2E_PORT!;
const ORIGIN = `http://127.0.0.1:${port}`;
test.afterAll(endSessionPool);

const big = (mb: number) => Buffer.alloc(mb * 1024 * 1024, 7);

test("unauthenticated upload is refused before the body is read", async ({ request }) => {
  const res = await request.post("/api/uploads", { data: big(1), headers: { origin: ORIGIN, "content-type": "application/octet-stream" } });
  expect(res.status()).toBe(401);
});

test("wrong origin is refused (with a valid session)", async ({ request }) => {
  const token = await mintSession();
  const res = await request.post("/api/uploads", { data: big(1), headers: { origin: "http://evil.test", cookie: `ytstudio_session=${token}`, "content-type": "application/octet-stream" } });
  expect(res.status()).toBe(403);
});

test("a 40 MB upload (beyond the proxy's 10 MB buffer) streams through with the right sha256", async ({ request }) => {
  const token = await mintSession();
  const body = big(40);
  const res = await request.post("/api/uploads", { data: body, headers: { origin: ORIGIN, cookie: `ytstudio_session=${token}`, "content-type": "application/octet-stream" }, timeout: 120_000 });
  expect(res.status()).toBe(201);
  const j = await res.json();
  expect(j.bytes).toBe(body.length);
  expect(j.sha256).toBe(createHash("sha256").update(body).digest("hex"));
});

test("an upload over the cap is cut off with 413", async ({ request }) => {
  const token = await mintSession();
  const res = await request.post("/api/uploads", { data: big(60), headers: { origin: ORIGIN, cookie: `ytstudio_session=${token}`, "content-type": "application/octet-stream" }, timeout: 120_000 });
  expect(res.status()).toBe(413);
});

test("responses carry the CSP and nosniff", async ({ request }) => {
  const res = await request.get("/login");
  const csp = res.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain("unsafe-eval"); // production build
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
});
