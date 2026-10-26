import { expect, test, type APIRequestContext } from "@playwright/test";
import { OWNER_PASSWORD, OWNER_USERNAME } from "../fixtures/owner";
import { endSessionPool, expireSession, mintSession, revokeSession } from "../fixtures/sessions";

// The e2e server runs with TRUST_PROXY=1: a unique x-forwarded-for per test plays the reverse proxy, so one test's
// lockout never leaks into another (all traffic is really 127.0.0.1).
const port = process.env.E2E_PORT!;
const ORIGIN = `http://127.0.0.1:${port}`;
const uniq = () => `203.0.113.${Math.floor(Math.random() * 250) + 1}`;
const uname = (p: string) => `${p}-${Math.random().toString(36).slice(2, 10)}`;
const cookie = (t: string) => ({ cookie: `ytstudio_session=${t}` });

function loginReq(request: APIRequestContext, body: object, headers: Record<string, string> = {}) {
  return request.post("/api/auth/login", {
    data: body,
    maxRedirects: 0,
    headers: { origin: ORIGIN, "x-forwarded-for": uniq(), ...headers },
  });
}

test.afterAll(endSessionPool);

test("no x-powered-by header", async ({ request }) => {
  for (const p of ["/healthz", "/login", "/api/me"]) expect((await request.get(p, { maxRedirects: 0 })).headers()["x-powered-by"], p).toBeUndefined();
});

test.describe("host allow-list", () => {
  for (const host of ["evil.test", "localhost.evil.test", "127.0.0.1.evil.test", "localhost@evil.test", "evil.test:3000"]) {
    test(`forged_host_is_rejected: ${host}`, async ({ request }) => {
      for (const path of ["/healthz", "/", "/login", "/api/me"]) {
        const res = await request.get(path, { headers: { host }, maxRedirects: 0 });
        expect(res.status(), `${host} ${path}`).toBe(400);
      }
    });
  }
  for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `LOCALHOST:${port}`, `[::1]:${port}`, `localhost.:${port}`]) {
    test(`host_with_port_and_ipv6_literal_are_accepted: ${host}`, async ({ request }) => {
      const res = await request.get("/healthz", { headers: { host } });
      expect(res.status()).toBe(200);
    });
  }
});

test.describe("without a session", () => {
  test("protected page redirects 307 to /login with the same-site next", async ({ request }) => {
    const res = await request.get("/", { maxRedirects: 0 });
    expect(res.status()).toBe(307);
    expect(new URL(res.headers().location!, ORIGIN).pathname + new URL(res.headers().location!, ORIGIN).search).toBe("/login?next=%2F");

    const deep = await request.get("/shorts/abc?tab=2", { maxRedirects: 0 });
    expect(deep.status()).toBe(307);
    expect(new URL(deep.headers().location!, ORIGIN).searchParams.get("next")).toBe("/shorts/abc?tab=2");
  });

  test("open redirect via the request path is neutralised", async ({ request }) => {
    const res = await request.get("/login/../%2F%2Fevil.test", { maxRedirects: 0 });
    for (const r of [res]) {
      if (r.status() === 307) {
        const loc = new URL(r.headers().location!, ORIGIN);
        expect(loc.origin).toBe(ORIGIN);
        expect(loc.searchParams.get("next") ?? "/").not.toMatch(/^\/\//);
      }
    }
  });

  test("protected api answers 401 JSON", async ({ request }) => {
    const res = await request.get("/api/me", { maxRedirects: 0 });
    expect(res.status()).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  test("public routes answer without a session", async ({ request }) => {
    for (const p of ["/login", "/healthz", "/readyz"]) expect((await request.get(p, { maxRedirects: 0 })).status(), p).toBe(200);
    expect(await (await request.get("/readyz")).json()).toEqual({ ok: true });
    const bad = await request.get("/setup/not-a-real-token", { maxRedirects: 0 });
    expect(bad.status()).toBe(200);
    expect(await bad.text()).toContain("This link is invalid or has expired");
    expect(bad.headers()["referrer-policy"]).toBe("no-referrer");
  });

  test("login-admin and setupx are not public", async ({ request }) => {
    expect((await request.get("/login-admin", { maxRedirects: 0 })).status()).toBe(307);
    expect((await request.get("/setupx", { maxRedirects: 0 })).status()).toBe(307);
  });
});

test.describe("session cookie checks", () => {
  test("/api/me: garbage, expired, revoked cookies -> 401; valid -> 200; query param never counts", async ({ request }) => {
    expect((await request.get("/api/me", { headers: cookie("garbage") })).status()).toBe(401);
    expect((await request.get("/api/me", { headers: cookie("x".repeat(500)) })).status()).toBe(401);

    const expired = await mintSession();
    await expireSession(expired);
    expect((await request.get("/api/me", { headers: cookie(expired) })).status()).toBe(401);

    const revoked = await mintSession();
    expect((await request.get("/api/me", { headers: cookie(revoked) })).status()).toBe(200);
    await revokeSession(revoked);
    expect((await request.get("/api/me", { headers: cookie(revoked) })).status()).toBe(401);

    const valid = await mintSession();
    const ok = await request.get("/api/me", { headers: cookie(valid) });
    expect(ok.status()).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    // token in the query string / a header / another cookie name is ignored
    expect((await request.get(`/api/me?ytstudio_session=${valid}`, { maxRedirects: 0 })).status()).toBe(401);
    expect((await request.get("/api/me", { headers: { authorization: `Bearer ${valid}` } })).status()).toBe(401);
    expect((await request.get("/api/me", { headers: { cookie: `other=${valid}` } })).status()).toBe(401);
  });

  test("protected page with a forged or revoked cookie never renders the protected content", async ({ request }) => {
    const revoked = await mintSession();
    await revokeSession(revoked);
    for (const t of ["garbage", revoked]) {
      const res = await request.get("/", { headers: cookie(t), maxRedirects: 0 });
      const body = await res.text();
      expect(body).not.toContain("Log out");
      expect(body).not.toMatch(/<h1[^>]*>YT Studio/);
      // the redirect happens inside the streamed response (Suspense), not as a 307
      expect(body).toMatch(/NEXT_REDIRECT|\/login/);
    }
    const valid = await mintSession();
    const ok = await request.get("/", { headers: cookie(valid) });
    expect(await ok.text()).toMatch(/YT Studio/);
  });
});

test.describe("api login route", () => {
  test("foreign or missing Origin -> 403 (also with a session cookie)", async ({ request }) => {
    const body = { username: OWNER_USERNAME, password: "whatever-whatever" };
    const mk = (headers: Record<string, string>) => request.post("/api/auth/login", { data: body, headers: { "x-forwarded-for": uniq(), ...headers }, maxRedirects: 0 });
    expect((await mk({ origin: "http://evil.test" })).status()).toBe(403);
    expect((await mk({ origin: `http://127.0.0.1.evil.test:${port}` })).status()).toBe(403);
    expect((await mk({ origin: "null" })).status()).toBe(403);
    expect((await mk({ origin: `http://localhost:${port}` })).status()).toBe(403); // allow-listed host, but not the Host header
    expect((await mk({})).status()).toBe(403);
    const token = await mintSession();
    expect((await mk({ ...cookie(token) })).status()).toBe(403);
    expect((await mk({ ...cookie(token), origin: "http://evil.test" })).status()).toBe(403);
    // same Origin as Host passes the origin gate (wrong password -> 401, not 403)
    expect((await mk({ origin: ORIGIN })).status()).toBe(401);
  });

  test("unknown user and wrong password are indistinguishable", async ({ request }) => {
    const a = await loginReq(request, { username: uname("nobody"), password: "wrong-password-123" });
    const b = await loginReq(request, { username: OWNER_USERNAME, password: "wrong-password-123" });
    expect(a.status()).toBe(401);
    expect(b.status()).toBe(401);
    expect(await a.text()).toBe(await b.text());
    for (const bad of [{ username: 1, password: "x" }, { username: "a" }, "nope"]) {
      expect((await loginReq(request, bad as object)).status()).toBe(400);
    }
  });

  test("success sets a HttpOnly SameSite=Lax cookie, no Secure on http, token not in the body, logout kills it", async ({ request, playwright }) => {
    const res = await loginReq(request, { username: OWNER_USERNAME, password: OWNER_PASSWORD });
    expect(res.status()).toBe(200);
    const setCookie = res.headers()["set-cookie"]!;
    expect(setCookie).toMatch(/^ytstudio_session=[A-Za-z0-9_-]{40,}; /);
    for (const f of ["HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=604800"]) expect(setCookie).toContain(f);
    expect(setCookie).not.toContain("Secure");
    const token = /^ytstudio_session=([^;]+)/.exec(setCookie)![1]!;
    expect(await res.text()).not.toContain(token);
    expect((await request.get("/api/me", { headers: cookie(token) })).status()).toBe(200);

    // logout needs the session and the same origin
    const anon = await playwright.request.newContext({ baseURL: ORIGIN }); // the shared `request` keeps the cookie jar
    const noSession = await anon.post("/api/auth/logout", { headers: { origin: ORIGIN }, maxRedirects: 0 });
    expect(noSession.status()).toBe(200); // idempotent, and it always clears the cookie
    expect(noSession.headers()["set-cookie"]).toContain("Max-Age=0");
    const stale = await anon.post("/api/auth/logout", { headers: { origin: ORIGIN, ...cookie("garbage") } });
    expect(stale.status()).toBe(200);
    expect(stale.headers()["set-cookie"]).toContain("Max-Age=0");
    await anon.dispose();
    expect((await request.post("/api/auth/logout", { headers: { ...cookie(token), origin: "http://evil.test" } })).status()).toBe(403);
    const out = await request.post("/api/auth/logout", { headers: { ...cookie(token), origin: ORIGIN } });
    expect(out.status()).toBe(200);
    expect(out.headers()["set-cookie"]).toContain("Max-Age=0");
    expect((await request.get("/api/me", { headers: cookie(token) })).status()).toBe(401);
  });

  test("Secure flag only when a trusted proxy says https", async ({ request }) => {
    const res = await loginReq(request, { username: OWNER_USERNAME, password: OWNER_PASSWORD }, { "x-forwarded-proto": "https" });
    expect(res.status()).toBe(200);
    expect(res.headers()["set-cookie"]).toContain("; Secure");
  });

  test("5 wrong attempts lock; changing x-forwarded-for does not unlock the username", async ({ request }) => {
    const name = uname("lockme");
    const ip = uniq();
    for (let i = 0; i < 5; i++) {
      const r = await loginReq(request, { username: name, password: "wrong-password-123" }, { "x-forwarded-for": ip });
      expect(r.status(), `attempt ${i + 1}`).toBe(401);
    }
    const locked = await loginReq(request, { username: name, password: "wrong-password-123" }, { "x-forwarded-for": ip });
    expect(locked.status()).toBe(429);
    expect(Number(locked.headers()["retry-after"])).toBeGreaterThan(0);
    // rotate the leftmost (client-supplied) hop and the whole address: still locked
    const rotated = await loginReq(request, { username: name, password: "wrong-password-123" }, { "x-forwarded-for": `${uniq()}, ${ip}` });
    expect(rotated.status()).toBe(429);
    const other = await loginReq(request, { username: name, password: "wrong-password-123" }, { "x-forwarded-for": uniq() });
    expect(other.status()).toBe(429);
  });

  test("busy -> 503 with Retry-After", async ({ request }) => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => loginReq(request, { username: uname("busy"), password: "wrong-password-123" })),
    );
    const busy = results.filter((r) => r.status() === 503);
    expect(busy.length).toBeGreaterThan(0);
    expect(busy[0]!.headers()["retry-after"]).toBe("2");
    expect(results.some((r) => r.status() === 401)).toBe(true);
  });
});

test.describe("server actions keep Next's origin check", () => {
  test("a Server Action POST with a foreign Origin is refused", async ({ request }) => {
    const res = await request.post("/login", {
      headers: { "next-action": "00".repeat(20), origin: "http://evil.test", "content-type": "text/plain;charset=UTF-8", "x-forwarded-for": uniq() },
      data: "[]",
      maxRedirects: 0,
    });
    expect(res.status()).not.toBe(200);
    expect(await res.text()).not.toContain("Incorrect");
  });
});
