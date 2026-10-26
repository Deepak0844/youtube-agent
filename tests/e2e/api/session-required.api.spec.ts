import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { isApiPath } from "@/lib/auth/policy";
import { ACTION_ALLOW } from "../../support/route-guards";
import { routeTable, type RouteEntry } from "../../support/route-table";
import { endSessionPool, expireSession, expireSessionAbsolute, mintSession, revokeSession } from "../fixtures/sessions";

// DERIVED session-required spec. The route table comes from the files under src/app (tests/support/route-table.ts), so a
// new page.tsx / route.ts is covered the moment it exists, and a route that forgets its guard fails here (CI), not in review.
// Every non-public route must refuse: no cookie, a garbage cookie, a valid-looking token nobody issued, an expired session,
// a revoked session, and credentials in places the app must never read (bearer header, query string, wrong cookie name),
// plus method, path, header and Host variants that try to slip past the proxy or the handler.
// auth-routes.api.spec.ts keeps the hand-written /api/me and login cases; this file adds the derived matrix only.
const port = process.env.E2E_PORT!;
const ORIGIN = `http://127.0.0.1:${port}`;
const TABLE = routeTable();
const PROTECTED = TABLE.filter((r) => !r.isPublic);

const forgedToken = () => randomBytes(32).toString("base64url"); // same shape as a real token, never issued
const cookieOf = (t: string) => ({ cookie: `ytstudio_session=${t}` });

// What a refusal looks like. Pages under cacheComponents redirect inside the streamed response, where Next writes this exact
// digest; the proxy answers 307 itself when there is no cookie. A body that merely CONTAINS "/login" is not a refusal.
const REDIRECT_DIGEST = "NEXT_REDIRECT;replace;/login;307;";
const isLoginRedirect = (res: APIResponse) => res.status() === 307 && new URL(res.headers().location ?? "", ORIGIN).pathname === "/login";
const redirectsToLogin = (res: APIResponse, body: string) => isLoginRedirect(res) || (res.status() === 200 && body.includes(REDIRECT_DIGEST));
const isApiRoute = (e: RouteEntry) => e.kind === "route" && isApiPath(e.url);

async function send(request: APIRequestContext, url: string, method: string, headers: Record<string, string>) {
  const res = await request.fetch(url, { method, headers, maxRedirects: 0 });
  return { res, body: method === "HEAD" ? "" : await res.text() };
}
type Sent = Awaited<ReturnType<typeof send>>;

function expectDenied(e: RouteEntry, method: string, state: string, r: Sent) {
  const label = `${method} ${e.url} (${state}) -> ${r.res.status()}`;
  if (isApiRoute(e)) {
    expect(r.res.status(), label).toBe(401);
    if (method !== "HEAD") expect(r.body, label).toBe(JSON.stringify({ error: "unauthorized" }));
  } else if (method === "HEAD") {
    // A HEAD response has no body, so a streamed redirect cannot be seen: it must be the proxy's 307 or an empty 200.
    expect(isLoginRedirect(r.res) || (r.res.status() === 200 && r.body === ""), label).toBe(true);
  } else {
    expect(redirectsToLogin(r.res, r.body), label).toBe(true);
  }
}

// Expected status of a request with a VALID session, per "METHOD /url". GET defaults to 200. A route with other methods must
// declare its control here, so a new route cannot ship without a positive control (the spec fails and says so).
const CONTROL_STATUS: Record<string, number> = {
  "POST /api/uploads": 201, // valid session + same Origin, empty body -> stored as an empty upload (not 401, not 403)
};
const controlStatus = (method: string, url: string): number | undefined => CONTROL_STATUS[`${method} ${url}`] ?? (method === "GET" ? 200 : undefined);

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
        ["empty cookie value", () => cookieOf("")],
        ["forged valid-looking token", () => cookieOf(forgedToken())],
        ["expired session", () => cookieOf(sessions.expired)],
        ["absolutely expired session (7-day limit)", () => cookieOf(sessions.absolute)],
        ["revoked session", () => cookieOf(sessions.revoked)],
        ["bearer token instead of a cookie", () => ({ authorization: `Bearer ${forgedToken()}` })],
        ["valid session token as a bearer header", () => ({ authorization: `Bearer ${sessions.valid}` })],
        ["valid session token in another cookie name", () => ({ cookie: `other=${sessions.valid}` })],
        ["valid session token under a wrong-case cookie name", () => ({ cookie: `YTSTUDIO_SESSION=${sessions.valid}` })],
        ["valid session token in the query string", () => ({}), "?ytstudio_session="],
        ["x-forwarded-* headers claiming loopback/https", () => ({ "x-forwarded-for": "127.0.0.1", "x-forwarded-proto": "https", "x-forwarded-host": "localhost", "x-real-ip": "127.0.0.1" })],
        ["x-forwarded-host pointing elsewhere", () => ({ "x-forwarded-host": "evil.test" })],
        ["x-middleware-subrequest (proxy bypass attempt)", () => ({ "x-middleware-subrequest": "middleware:middleware:middleware:middleware:middleware" })],
        ["x-middleware-subrequest naming the proxy", () => ({ "x-middleware-subrequest": "src/proxy:src/proxy:proxy:proxy:proxy" })],
      ];
      // More than one ytstudio_session cookie is ambiguous (first-vs-last parsers differ), so it is NO session, in either order,
      // for pages and API routes alike (readSessionCookie fails closed; pages read the same header).
      states.push(
        ["garbage cookie first, valid cookie second", () => ({ cookie: `ytstudio_session=garbage; ytstudio_session=${sessions.valid}` })],
        ["valid cookie first, garbage cookie second", () => ({ cookie: `ytstudio_session=${sessions.valid}; ytstudio_session=garbage` })],
        ["the same valid cookie twice", () => ({ cookie: `ytstudio_session=${sessions.valid}; ytstudio_session=${sessions.valid}` })],
      );
      for (const [state, headers, q] of states) {
        test(`refuses: ${state}`, async ({ request }) => {
          expectDenied(e, method, state, await send(request, e.url + (q ? q + sessions.valid : ""), method, headers()));
        });
      }

      test("control: a valid session is NOT refused and gets the expected success status", async ({ request }) => {
        const want = controlStatus(method, e.url);
        expect(want, `declare the expected valid-session status of ${method} ${e.url} in CONTROL_STATUS`).toBeDefined();
        const { res, body } = await send(request, e.url, method, { ...cookieOf(sessions.valid), origin: ORIGIN });
        expect(res.status(), `${method} ${e.url}`).toBe(want);
        expect(body, "a valid session must not be redirected").not.toContain(REDIRECT_DIGEST);
      });
    });
  }

  // Methods the route does NOT export (plus HEAD/OPTIONS): never a success that runs the handler or leaks content. Acceptable:
  // the same refusal, 405, or Next's own empty 204 answer to OPTIONS. HEAD of an exported GET is run by Next as GET, so it
  // must be the strict refusal.
  const extra = (e.kind === "route" ? ["HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"] : ["HEAD", "OPTIONS", "PUT", "PATCH", "DELETE"]).filter((m) => !e.methods.includes(m));
  test.describe(`other methods on ${e.url}`, () => {
    for (const method of extra) {
      for (const [state, headers] of [
        ["no cookie", {}],
        ["garbage cookie", cookieOf("garbage")],
        ["revoked session", () => cookieOf(sessions.revoked)],
      ] as [string, Record<string, string> | (() => Record<string, string>)][]) {
        test(`${method} with ${state}`, async ({ request }) => {
          const r = await send(request, e.url, method, typeof headers === "function" ? headers() : headers);
          const s = r.res.status();
          const strict = method === "HEAD" && e.methods.includes("GET");
          const emptyOptions = method === "OPTIONS" && s === 204 && r.body === "";
          const ok = strict ? (() => { try { expectDenied(e, "HEAD", state, r); return true; } catch { return false; } })() : isLoginRedirect(r.res) || s === 401 || s === 405 || emptyOptions || (method === "HEAD" && s === 200 && r.body === "" && e.kind === "page");
          expect(ok, `${method} ${e.url} (${state}) -> ${s} body=${r.body.slice(0, 80)}`).toBe(true);
        });
      }
    }
  });

  // Path and Host variants that try to reach the same handler by another spelling. None may return content: allowed are the
  // proxy's 307 to /login, Next's 308 to the canonical path (which is then judged as above), 401, 404 (no such route).
  test.describe(`path and Host variants of ${e.url}`, () => {
    const variants: [string, string | null][] = [
      ["trailing slash", e.url === "/" ? null : e.url + "/"],
      ["upper case", e.url.toUpperCase() === e.url ? null : e.url.toUpperCase()],
      ["double-encoded first letter", e.url === "/" ? null : e.url.replace(/^\/(.)/, (_m, c: string) => `/%25${c.charCodeAt(0).toString(16)}`)],
      ["single-encoded first letter", e.url === "/" ? null : e.url.replace(/^\/(.)/, (_m, c: string) => `/%${c.charCodeAt(0).toString(16)}`)],
      ["dot segment", e.url === "/" ? null : e.url.replace(/^\/(.)/, "/./$1")],
      ["empty segment", e.url === "/" ? null : e.url.replace(/^\/([^/]+)/, "/$1/")],
    ];
    for (const [name, url] of variants) {
      if (!url) continue;
      for (const [state, headers] of [["no cookie", {}], ["garbage cookie", cookieOf("garbage")]] as [string, Record<string, string>][]) {
        test(`${name} (${url}) with ${state}`, async ({ request }) => {
          const method = e.methods[0]!;
          const r = await send(request, url, method, headers);
          const s = r.res.status();
          const canonical = new URL(r.res.headers().location ?? "", ORIGIN).pathname;
          const ok = isLoginRedirect(r.res) || s === 401 || s === 404 || (s === 308 && (canonical === e.url || canonical === url.replace(/\/+$/, "") || canonical === "/" + url.replace(/^\/+/, "")));
          expect(ok, `${method} ${url} (${state}) -> ${s} ${r.res.headers().location ?? ""}`).toBe(true);
          if (s === 404) expect(r.body, "a 404 must not carry the protected content").not.toContain(REDIRECT_DIGEST.replace("NEXT_REDIRECT", "NEVER"));
        });
      }
    }
    // Proxy-excluded paths skip the Host guard by design (their handlers check Origin/Host themselves; route-inventory asserts that).
    test("absurd Host port is refused (400), with and without a valid session", async ({ request }) => {
      test.skip(e.proxyExcluded, "the proxy does not run on this path");
      for (const headers of [{ host: "localhost:99999" }, { host: "localhost:99999", ...cookieOf(sessions.valid) }]) {
        expect((await request.fetch(e.url, { method: e.methods[0], headers, maxRedirects: 0 })).status(), e.url).toBe(400);
      }
    });
  });
}

// ---- Server Actions ---------------------------------------------------------------------------------------------------------
// Server Actions are POSTs to the page route carrying a `next-action` id. The ids come from the REAL build
// (.next/server/server-reference-manifest.json), so every protected action in src/app is exercised with its true id. Today every
// action in the app is one of the three public ones in ACTION_ALLOW; the first protected action added to src/app is picked up here.
interface ManifestEntry {
  workers: Record<string, unknown>;
  filename: string;
  exportedName: string;
}
const readManifest = (): Record<string, ManifestEntry> => JSON.parse(readFileSync(".next/server/server-reference-manifest.json", "utf8")).node;
const pageUrlOfWorker = (w: string) =>
  "/" + w.replace(/^app\//, "").replace(/(^|\/)page$/, "").split("/").filter((s) => s && !/^\(.*\)$/.test(s)).map((s) => (s.startsWith("[") ? "x" : s)).join("/");
const actionHeaders = (id: string, h: Record<string, string>) => ({ "next-action": id, "content-type": "text/plain;charset=UTF-8", origin: ORIGIN, ...h });

test.describe("server actions", () => {
  test("the build manifest lists the known public actions (so discovery is working) and nothing unlisted is public", () => {
    const names = Object.values(readManifest()).map((m) => m.exportedName);
    for (const n of ACTION_ALLOW) expect(names, n).toContain(n);
  });

  test("every PROTECTED action (real id) refuses no cookie, garbage, forged, expired, absolute-expired and revoked sessions", async ({ request }) => {
    const protectedActions = Object.entries(readManifest()).filter(([, m]) => !ACTION_ALLOW.includes(m.exportedName));
    for (const [id, m] of protectedActions) {
      for (const worker of Object.keys(m.workers)) {
        const url = pageUrlOfWorker(worker);
        const none = await request.post(url, { headers: actionHeaders(id, {}), data: "[]", maxRedirects: 0 });
        expect(isLoginRedirect(none), `${m.exportedName} ${url} no cookie -> ${none.status()}`).toBe(true);
        for (const h of [cookieOf("garbage"), cookieOf(forgedToken()), cookieOf(sessions.expired), cookieOf(sessions.absolute), cookieOf(sessions.revoked)]) {
          const res = await request.post(url, { headers: actionHeaders(id, h), data: "[]", maxRedirects: 0 });
          const redirected = (res.headers()["x-action-redirect"] ?? "").startsWith("/login") || isLoginRedirect(res) || res.status() === 303;
          expect(redirected, `${m.exportedName} ${url} ${JSON.stringify(h)} -> ${res.status()}`).toBe(true);
        }
      }
    }
  });

  // What this proves, and what it does not: an UNKNOWN action id is never executed. With no cookie the proxy answers 307 to
  // /login; with any cookie Next itself answers 400 "Invalid Server Action request." (it is Next, not our session check, that
  // refuses). The real per-action session check is covered by the test above and by route-inventory's checkActionFile.
  test("an unknown action id never executes (proxy 307 without a cookie, Next 400 with one)", async ({ request }) => {
    for (const e of PROTECTED.filter((r) => r.kind === "page")) {
      const none = await request.post(e.url, { headers: actionHeaders("00".repeat(20), {}), data: "[]", maxRedirects: 0 });
      expect(isLoginRedirect(none), `${e.url} no cookie -> ${none.status()}`).toBe(true);
      for (const h of [cookieOf("garbage"), cookieOf(forgedToken()), cookieOf(sessions.expired), cookieOf(sessions.revoked)]) {
        const res = await request.post(e.url, { headers: actionHeaders("00".repeat(20), h), data: "[]", maxRedirects: 0 });
        expect(res.status(), `${e.url} ${JSON.stringify(h)}`).toBe(400);
        expect(await res.text()).toBe("Invalid Server Action request.");
      }
    }
  });
});

test.describe("Host allow-list on every route the proxy covers", () => {
  const covered = TABLE.filter((r) => !r.proxyExcluded);
  test("the covered set is derived and non-empty", () => expect(covered.length).toBeGreaterThanOrEqual(5));
  for (const e of covered) {
    for (const host of ["evil.test", "localhost.evil.test", "localhost@evil.test", "localhost:99999"]) {
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
