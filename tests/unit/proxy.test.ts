import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";
import { proxy } from "@/proxy";

const COOKIE = "ytstudio_session=abc123";
const req = (path: string, o: { method?: string; headers?: Record<string, string> } = {}) =>
  new NextRequest(`http://127.0.0.1:3000${path}`, { method: o.method ?? "GET", headers: { host: "127.0.0.1:3000", ...(o.headers ?? {}) } });
/** A Server Function call: a POST carrying the Next-Action header. */
const action = (path: string, h: Record<string, string> = {}) => req(path, { method: "POST", headers: { "next-action": "abc", cookie: COOKIE, ...h } });
const passes = (r: Response) => r.status === 200 && r.headers.get("x-middleware-next") === "1";

describe("server actions must come from this site (every action, in one place)", () => {
  it("a same-origin action with a session cookie passes through", () => {
    expect(passes(proxy(action("/settings/keys", { origin: "http://127.0.0.1:3000" })))).toBe(true);
  });
  it("a missing, 'null' or foreign Origin is refused with 403, even with a valid-looking cookie", () => {
    for (const origin of [undefined, "null", "https://evil.example", "http://127.0.0.1:9999", "not a url"]) {
      const r = proxy(action("/settings/keys", origin === undefined ? {} : { origin }));
      expect(r.status, String(origin)).toBe(403);
      expect(r.headers.get("cache-control")).toBe("no-store");
    }
  });
  it("applies to the public pages too (login and the setup link), not only to protected ones", () => {
    expect(proxy(action("/login", { origin: "https://evil.example" })).status).toBe(403);
    expect(proxy(action("/setup/sometoken")).status).toBe(403);
    expect(passes(proxy(action("/login", { origin: "http://127.0.0.1:3000", cookie: "" })))).toBe(true);
  });
  it("is the same check the per-action guard uses, so the two can never disagree", () => {
    const h = { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" };
    expect(passes(proxy(action("/queue", h)))).toBe(true);
  });
});

describe("what this rule leaves alone", () => {
  it("an ordinary page request is not affected (no Next-Action header, no Origin needed)", () => {
    expect(passes(proxy(req("/queue", { headers: { cookie: COOKIE } })))).toBe(true);
  });
  it("a POST without the Next-Action header is not a server action: it falls through to the session check", () => {
    expect(passes(proxy(req("/queue", { method: "POST", headers: { cookie: COOKIE } })))).toBe(true);
    expect(proxy(req("/queue", { method: "POST" })).status).toBe(307); // no cookie: to the login page, as before
  });
  it("a GET with the Next-Action header is not a server action call", () => {
    expect(passes(proxy(req("/queue", { headers: { "next-action": "abc", cookie: COOKIE } })))).toBe(true);
  });
  it("the host check still comes first (400 for a forged Host), and no cookie still goes to login", () => {
    expect(proxy(new NextRequest("http://evil.example/queue", { method: "POST", headers: { host: "evil.example", "next-action": "abc", origin: "http://evil.example", cookie: COOKIE } })).status).toBe(400);
    const r = proxy(req("/queue"));
    expect(r.status).toBe(307);
    expect(r.headers.get("location")).toContain("/login");
  });
});

describe("response headers", () => {
  it("every page carries the CSP, nosniff, same-origin referrer, no framing (also for old browsers) and a locked-down permissions policy", async () => {
    const rules = await nextConfig.headers!();
    const all = rules.find((r) => r.source === "/:path*")!.headers;
    const get = (k: string) => all.find((h) => h.key === k)?.value;
    expect(get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(get("X-Content-Type-Options")).toBe("nosniff");
    expect(get("Referrer-Policy")).toBe("same-origin");
    expect(get("X-Frame-Options")).toBe("DENY");
    for (const feature of ["camera=()", "microphone=()", "geolocation=()"]) expect(get("Permissions-Policy")).toContain(feature);
  });
  it("signed media files get the strictest policy (later entry wins)", async () => {
    const rules = await nextConfig.headers!();
    expect(rules.find((r) => r.source === "/api/media/:path*")!.headers).toEqual([{ key: "Content-Security-Policy", value: "default-src 'none'; sandbox" }]);
  });
});
