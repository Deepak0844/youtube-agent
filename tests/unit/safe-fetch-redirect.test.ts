import { describe, expect, it } from "vitest";
import { BlockedRedirectError, originKey, planRedirect, policyFor } from "@/server/providers/net/safe-fetch";

const secretHeaders = () =>
  new Headers({
    accept: "application/json",
    "accept-language": "en",
    "user-agent": "ytstudio",
    "content-type": "application/json",
    authorization: "Bearer a",
    cookie: "c=1",
    "proxy-authorization": "Basic b",
    "x-api-key": "k1",
    "xi-api-key": "k2",
    "x-custom-token": "k3",
  });

const step = (method = "GET", body?: string) => ({ method, body, headers: secretHeaders() });
const u = (s: string) => new URL(s);
const ORIGIN = originKey(u("http://a.test:8080/"));

describe("origin key", () => {
  it("normalises case and default ports", () => {
    expect(originKey(u("http://A.Test/x"))).toBe(originKey(u("http://a.test:80/y")));
    expect(originKey(u("https://a.test/"))).toBe(originKey(u("https://a.test:443/")));
    expect(originKey(u("http://[::1]:80/"))).toBe(originKey(u("http://[0:0::1]/")));
  });

  it("differs by scheme, host and port", () => {
    const base = originKey(u("http://a.test/"));
    expect(originKey(u("https://a.test/"))).not.toBe(base);
    expect(originKey(u("http://b.test/"))).not.toBe(base);
    expect(originKey(u("http://a.test:81/"))).not.toBe(base);
    expect(originKey(u("http://a.test:443/"))).not.toBe(originKey(u("https://a.test/")));
  });
});

describe("policyFor", () => {
  it("keeps the caller's mode on the original origin and goes strict elsewhere", () => {
    expect(policyFor(u("http://A.TEST:8080/next"), ORIGIN, "typed")).toBe("typed");
    expect(policyFor(u("http://a.test:8081/"), ORIGIN, "typed")).toBe("indirect");
    expect(policyFor(u("http://b.test:8080/"), ORIGIN, "typed")).toBe("indirect");
    expect(policyFor(u("https://a.test:8080/"), ORIGIN, "typed")).toBe("indirect");
    expect(policyFor(u("http://a.test:8080/"), ORIGIN, "indirect")).toBe("indirect");
  });
});

describe("planRedirect", () => {
  it("cross_origin_redirect_drops_custom_secret_headers", () => {
    const next = planRedirect(u("http://a.test:8080/"), u("http://b.test:8080/"), 302, ORIGIN, step());
    expect([...next.headers.keys()].sort()).toEqual(["accept", "accept-language", "user-agent"]);
  });

  it("cross_origin_to_other_port_drops_headers", () => {
    const next = planRedirect(u("http://a.test:8080/"), u("http://a.test:9090/"), 307, ORIGIN, step());
    expect([...next.headers.keys()].sort()).toEqual(["accept", "accept-language", "user-agent"]);
  });

  it("same_origin_redirect_keeps_headers", () => {
    const next = planRedirect(u("http://a.test:8080/"), u("http://A.test:8080/b"), 307, ORIGIN, step("POST", "x"));
    expect(next.headers.get("x-api-key")).toBe("k1");
    expect(next.headers.get("authorization")).toBe("Bearer a");
    expect(next.headers.get("content-type")).toBe("application/json");
    expect(next).toMatchObject({ method: "POST", body: "x" });
  });

  it("headers_stay_dropped_once_the_chain_left_the_origin", () => {
    const away = planRedirect(u("http://a.test:8080/"), u("http://b.test/"), 302, ORIGIN, step());
    const back = planRedirect(u("http://b.test/"), u("http://a.test:8080/"), 302, ORIGIN, away);
    expect(back.headers.get("x-api-key")).toBeNull();
  });

  it.each([307, 308])("cross_origin_%i_with_body_is_refused", (status) => {
    const err = (() => {
      try {
        return planRedirect(u("http://a.test:8080/"), u("http://b.test/"), status, ORIGIN, step("POST", "secret"));
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(BlockedRedirectError);
    expect((err as BlockedRedirectError).reason).toBe("cross-origin-redirect-with-body");
  });

  it.each([301, 302, 303])("cross_origin_%i_post_becomes_get_without_body", (status) => {
    const next = planRedirect(u("http://a.test:8080/"), u("http://b.test/"), status, ORIGIN, step("POST", "secret"));
    expect(next.method).toBe("GET");
    expect(next.body).toBeUndefined();
    expect(next.headers.get("content-type")).toBeNull();
  });

  it.each([
    ["cross origin", "https://a.test/", "http://b.test/"],
    ["same host", "https://a.test/", "http://a.test/"],
    ["same host and port", "https://a.test:8443/", "http://a.test:8443/"],
  ])("https_to_http_redirect_is_refused_%s", (_n, from, to) => {
    const origin = originKey(u(from));
    expect(() => planRedirect(u(from), u(to), 302, origin, step())).toThrow(BlockedRedirectError);
    try {
      planRedirect(u(from), u(to), 302, origin, step());
    } catch (e) {
      expect((e as BlockedRedirectError).reason).toBe("https-downgrade");
    }
  });

  it("http_to_https_upgrade_is_allowed_but_cross_origin", () => {
    const next = planRedirect(u("http://a.test/"), u("https://a.test/"), 301, originKey(u("http://a.test/")), step());
    expect(next.headers.get("x-api-key")).toBeNull();
  });
});
