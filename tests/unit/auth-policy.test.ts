import { describe, expect, it } from "vitest";
import { isAllowedHost, isPublicPath, normalizePath, parseAllowedHosts, safeNext, PUBLIC_ROUTES } from "@/lib/auth/policy";
import { clientIpFrom } from "@/lib/auth/client-ip";
import { isSecureRequest, readSessionCookie, serializeClearCookie, serializeSessionCookie } from "@/lib/auth/session-cookie";

const allowed = parseAllowedHosts(undefined);

describe("host allow-list", () => {
  it.each(["localhost", "LOCALHOST", "localhost:3000", "127.0.0.1", "127.0.0.1:3000", "[::1]", "[::1]:3000", "localhost.", "localhost.:3000"])(
    "accepts %s",
    (h) => expect(isAllowedHost(h, allowed)).toBe(true),
  );
  it.each([
    "evil.test", "localhost.evil.test", "127.0.0.1.evil.test", "", "a@localhost", "localhost/x", "localhost x", "localhost:abc",
    "localhost:", "localhost:99999999", "::1", "[::1", "localhost@evil.test", "evil.test:3000", "localhost\u0000", "localhost,evil.test", "localhost?x",
  ])("rejects %j", (h) => expect(isAllowedHost(h, allowed)).toBe(false));
  it("rejects a missing host", () => {
    expect(isAllowedHost(null, allowed)).toBe(false);
    expect(isAllowedHost(undefined, allowed)).toBe(false);
  });
  it("extra hosts come from the env list, normalised", () => {
    const a = parseAllowedHosts(" Studio.Example.com ,, [::1] ");
    expect(isAllowedHost("studio.example.com:8443", a)).toBe(true);
    expect(isAllowedHost("localhost", a)).toBe(false); // an explicit list replaces the default
  });
});

describe("public path policy", () => {
  it.each([
    ["/login", true], ["/login/", true], ["/login?x=1", true], ["/login-admin", false], ["/loginx", false], ["/login/x", false],
    ["/setup/x", true], ["/setup/", true], ["/setupx", false], ["/setup-x/y", false],
    ["/healthz", true], ["/healthz/x", false], ["/readyz", true],
    ["/api/v1", true], ["/api/v1/shorts", true], ["/api/v1x", false], ["/api/media/abc", true], ["/api/webhooks/stripe", true], ["/api/oauth/callback", true],
    ["/api/auth/login", true], ["/api/auth/logout", true], ["/api/auth/logout/x", false], ["/api/me", false], ["/", false], ["/shorts", false],
    ["//login", true], ["/login/../api/me", false], ["/api/v1/../me", false], ["/%6Cogin", true], ["/%6cogin/..%2Fapi/me", false],
    ["/Login", false], ["/LOGIN", false], ["/login%2F..%2Fapi%2Fme", false], ["/%2e%2e/login", true],
    ["/%zz", false], ["/%E0%A4%A", false], ["/login\\..\\api", false], ["/login%00", false], ["/api/v1%2F..%2Fme", false],
  ])("isPublicPath(%j) = %s", (p, expected) => expect(isPublicPath(p)).toBe(expected));
  it("never treats an undecodable path as public", () => {
    expect(normalizePath("/%E0%A4%A")).toBeNull();
    expect(isPublicPath("/login%")).toBe(false);
  });
  it("exposes the list for the route inventory", () => expect(PUBLIC_ROUTES.length).toBeGreaterThan(5));
});

describe("safeNext", () => {
  it.each([
    ["/", "/"], ["/shorts?a=1", "/shorts?a=1"], ["/a/b#c", "/a/b#c"],
    ["//evil.test", "/"], ["https://evil.test", "/"], ["http://evil.test/x", "/"], ["/\\evil.test", "/"], ["\\\\evil.test", "/"],
    ["/a\\b", "/"], ["javascript:alert(1)", "/"], ["evil.test", "/"], ["", "/"], ["/\tx", "/"], ["/\nx", "/"], ["/\u0000x", "/"],
    ["/a:b", "/a:b"], [":/x", "/"], ["/%2F%2Fevil.test", "/%2F%2Fevil.test"], [undefined, "/"], [null, "/"], [["/a"], "/"],
  ])("safeNext(%j) = %j", (raw, expected) => expect(safeNext(raw as string)).toBe(expected));
  it("caps the length", () => expect(safeNext("/" + "a".repeat(3000))).toBe("/"));
});

describe("client ip", () => {
  const h = (xff?: string) => new Headers(xff === undefined ? {} : { "x-forwarded-for": xff });
  it("without a trusted proxy the header is never read", () => {
    expect(clientIpFrom(h("9.9.9.9"), { trustProxy: false })).toBe("unknown");
    expect(clientIpFrom(h(), { trustProxy: false })).toBe("unknown");
  });
  it.each([
    ["1.2.3.4", "1.2.3.4"],
    ["6.6.6.6, 1.2.3.4", "1.2.3.4"], // leftmost is client-supplied, rightmost is the proxy's
    ["6.6.6.6, 7.7.7.7, 1.2.3.4 ", "1.2.3.4"],
    ["::ffff:1.2.3.4", "1.2.3.4"],
    ["2001:DB8::1", "2001:db8::1"],
    ["1.2.3.4, not-an-ip", "unknown"],
    ["1.2.3.4,", "unknown"],
    ["", "unknown"],
    ["x".repeat(100), "unknown"],
  ])("trusted proxy: %j -> %s", (xff, expected) => expect(clientIpFrom(h(xff), { trustProxy: true })).toBe(expected));
  it("missing header -> unknown", () => expect(clientIpFrom(h(), { trustProxy: true })).toBe("unknown"));
});

describe("session cookie", () => {
  it("sets the required flags and Secure only on https", () => {
    const plain = serializeSessionCookie("tok", { secure: false });
    expect(plain).toMatch(/^ytstudio_session=tok; /);
    for (const f of ["HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=604800"]) expect(plain).toContain(f);
    expect(plain).not.toContain("Secure");
    expect(serializeSessionCookie("tok", { secure: true })).toContain("; Secure");
  });
  it("clear cookie expires immediately with the same flags", () => {
    const c = serializeClearCookie({ secure: true });
    expect(c).toContain("Max-Age=0");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Secure");
  });
  it("secure detection: url protocol unless a trusted proxy says https", () => {
    expect(isSecureRequest({ protocol: "http:", forwardedProto: "https", trustProxy: false })).toBe(false);
    expect(isSecureRequest({ protocol: "https:", forwardedProto: null, trustProxy: false })).toBe(true);
    expect(isSecureRequest({ protocol: "http:", forwardedProto: "https", trustProxy: true })).toBe(true);
    expect(isSecureRequest({ protocol: "http:", forwardedProto: "http", trustProxy: true })).toBe(false);
    expect(isSecureRequest({ protocol: "https:", forwardedProto: "http", trustProxy: true })).toBe(false);
  });
  it("reads only the exact cookie name", () => {
    expect(readSessionCookie("a=1; ytstudio_session=abc; b=2")).toBe("abc");
    expect(readSessionCookie("xytstudio_session=abc")).toBeNull();
    expect(readSessionCookie("ytstudio_session=")).toBeNull();
    expect(readSessionCookie(null)).toBeNull();
  });
});
