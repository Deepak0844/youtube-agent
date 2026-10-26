import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { isApiPath } from "@/lib/auth/policy";
import { routeTable, type RouteEntry } from "../../support/route-table";
import { endSessionPool, expireSession, expireSessionAbsolute, mintSession, revokeSession } from "../fixtures/sessions";

// DERIVED session-required spec. The route table comes from the files under src/app (tests/support/route-table.ts), so a
// new page.tsx / route.ts is covered the moment it exists, and a route that forgets its guard fails here (CI), not in review.
// Every non-public route must refuse: no cookie, a garbage cookie, a valid-looking token nobody issued, an expired session,
// a revoked session, and credentials in places the app must never read (bearer header, query string).
// auth-routes.api.spec.ts keeps the hand-written /api/me and login cases; this file adds the derived matrix only.
const port = process.env.E2E_PORT!;
const ORIGIN = `http://127.0.0.1:${port}`;
const TABLE = routeTable();
const PROTECTED = TABLE.filter((r) => !r.isPublic);

const forgedToken = () => randomBytes(32).toString("base64url"); // same shape as a real token, never issued
const cookieOf = (t: string) => ({ cookie: `ytstudio_session=${t}` });

// Streamed pages redirect inside the response (Suspense), so a 200 whose body carries NEXT_REDIRECT to /login also counts.
function redirectsToLogin(res: APIResponse, body: string): boolean {
  if (res.status() === 307) return new URL(res.headers().location ?? "", ORIGIN).pathname === "/login";
  return /NEXT_REDIRECT/.test(body) && /\/login/.test(body);
}

async function send(request: APIRequestContext, e: RouteEntry, method: string, headers: Record<string, string>, query = ""): Promise<{ res: APIResponse; body: string }> {
  const res = await request.fetch(e.url + query, { method, headers, maxRedirects: 0 });
  return { res, body: await res.text() };
}

function expectDenied(e: RouteEntry, method: string, state: string, r: { res: APIResponse; body: string }) {
  const label = `${method} ${e.url} (${state}) -> ${r.res.status()}`;
  if (e.kind === "route" && isApiPath(e.url)) {
    expect(r.res.status(), label).toBe(401);
    expect(r.body, label).toBe(JSON.stringify({ error: "unauthorized" }));
  } else {
    expect(redirectsToLogin(r.res, r.body), label).toBe(true);
  }
}

let sessions: { expired: string; absolute: string; revoked: string; valid: string };
test.beforeAll(async () => {
  const expired = await mintSession();
  await expireSession(expired);
  const absolute = await mintSession();
  await expireSessionAbsolute(absolute);
  const revoked = await mintSession();
  await revokeSession(revoked);
  sessions = { expired, absolute, revoked, valid: await mintSession() };
});
test.afterAll(endSessionPool);

test("the derived table is not empty and contains the known routes", () => {
  expect(PROTECTED.length).toBeGreaterThanOrEqual(3);
  const urls = TABLE.map((r) => r.url);
  for (const u of ["/", "/api/me", "/api/uploads", "/login", "/healthz"]) expect(urls, u).toContain(u);
});

for (const e of PROTECTED) {
  for (const method of e.methods) {
    test.describe(`${method} ${e.url} (${e.file.replace(/^.*src\/app\//, "")})`, () => {
      const states: [string, () => Record<string, string>, string?][] = [
        ["no cookie", () => ({})],
        ["garbage cookie", () => cookieOf("garbage")],
        ["oversized cookie", () => cookieOf("x".repeat(500))],
        ["forged valid-looking token", () => cookieOf(forgedToken())],
        ["expired session", () => cookieOf(sessions.expired)],
        ["absolutely expired session (7-day limit)", () => cookieOf(sessions.absolute)],
        ["revoked session", () => cookieOf(sessions.revoked)],
        ["bearer token instead of a cookie", () => ({ authorization: `Bearer ${forgedToken()}` })],
        ["valid session token as a bearer header", () => ({ authorization: `Bearer ${sessions.valid}` })],
        ["valid session token in another cookie name", () => ({ cookie: `other=${sessions.valid}` })],
        ["valid session token in the query string", () => ({}), `?ytstudio_session=`],
      ];
      for (const [state, headers, q] of states) {
        test(`refuses: ${state}`, async ({ request }) => {
          const r = await send(request, e, method, headers(), q ? q + sessions.valid : "");
          expectDenied(e, method, state, r);
        });
      }

      test("control: a valid session is NOT refused (so the refusals above are not vacuous)", async ({ request }) => {
        const { res, body } = await send(request, e, method, cookieOf(sessions.valid));
        expect(res.status(), `${method} ${e.url}`).not.toBe(401);
        expect(redirectsToLogin(res, body), `${method} ${e.url} redirected a valid session to /login`).toBe(false);
      });
    });
  }

  if (e.kind === "page") {
    // Server Actions are POSTs to the page route: with no cookie the proxy stops them; with a bad cookie an unknown action id never succeeds.
    test(`server-action POST to ${e.url} never succeeds without a valid session`, async ({ request }) => {
      for (const headers of [{}, cookieOf("garbage"), cookieOf(forgedToken()), cookieOf(sessions.expired), cookieOf(sessions.revoked)]) {
        const res = await request.post(e.url, { headers: { "next-action": "00".repeat(20), "content-type": "text/plain;charset=UTF-8", origin: ORIGIN, ...headers }, data: "[]", maxRedirects: 0 });
        expect(res.status(), `${e.url} ${JSON.stringify(headers)}`).not.toBeLessThan(300);
        expect(res.status(), `${e.url} ${JSON.stringify(headers)}`).not.toBe(200);
      }
    });
  }
}

test.describe("Host allow-list on every route the proxy covers", () => {
  const covered = TABLE.filter((r) => !r.proxyExcluded);
  test("the covered set is derived and non-empty", () => expect(covered.length).toBeGreaterThanOrEqual(5));
  for (const e of covered) {
    for (const host of ["evil.test", "localhost.evil.test", "localhost@evil.test"]) {
      test(`bad Host ${host} -> 400 on ${e.url}`, async ({ request }) => {
        // with a valid session too: a forged Host must not be rescued by being logged in
        for (const headers of [{ host }, { host, ...cookieOf(sessions.valid) }]) {
          const res = await request.get(e.url, { headers, maxRedirects: 0 });
          expect(res.status(), `${e.url} ${host}`).toBe(400);
        }
      });
    }
  }
});
