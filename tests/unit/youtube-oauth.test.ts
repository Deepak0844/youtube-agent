import { describe, expect, it } from "vitest";
import { GOOGLE_SCOPES, buildAuthUrl, channelSecretName, missingScopes, parseChannels, pkceChallenge, quotaCost, quotaDay, randomToken } from "@/server/core/youtube-oauth";

describe("youtube oauth helpers", () => {
  it("random tokens are 43 chars and differ", () => {
    const a = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(a);
  });
  it("PKCE challenge matches the RFC 7636 example", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
  it("auth url asks offline + consent + S256 + every scope", () => {
    const u = new URL(buildAuthUrl({ clientId: "cid", redirectUri: "http://localhost:3000/api/oauth/google/callback", state: "st", verifier: "v".repeat(43) }));
    const p = u.searchParams;
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("prompt")).toBe("consent");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("state")).toBe("st");
    expect(p.get("response_type")).toBe("code");
    expect(p.get("scope")!.split(" ")).toEqual([...GOOGLE_SCOPES]);
    expect(u.search).not.toContain("client_secret");
  });
  it("missingScopes names what was unticked", () => {
    expect(missingScopes(GOOGLE_SCOPES.join(" "))).toEqual([]);
    expect(missingScopes(GOOGLE_SCOPES.slice(0, 3).join(" "))).toHaveLength(GOOGLE_SCOPES.length - 3);
  });
  it("missingScopes accepts Google's long email scope and extras", () => {
    const g = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/yt-analytics.readonly https://www.googleapis.com/auth/youtube.force-ssl";
    expect(missingScopes(g)).toEqual([]);
  });
  it("missingScopes still fails when a youtube scope is absent", () => {
    const g = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.force-ssl";
    expect(missingScopes(g)).toEqual(["https://www.googleapis.com/auth/yt-analytics.readonly"]);
  });
  it("parseChannels keeps only well-formed items", () => {
    expect(parseChannels({ items: [{ id: "UCabc_-1", snippet: { title: "Mine" } }, { id: "bad id" }, { snippet: {} }] })).toEqual([{ channelId: "UCabc_-1", title: "Mine" }]);
    expect(parseChannels(null)).toEqual([]);
  });
  it("vault name is valid for the vault", () => {
    expect(channelSecretName("3f2b8c1e-0000-4000-8000-000000000001")).toMatch(/^[a-z0-9][a-z0-9._-]{0,127}$/);
  });
  it("quota day follows Pacific time", () => {
    expect(quotaDay(new Date("2026-11-04T07:30:00Z"))).toBe("2026-11-03"); // 23:30 PST
    expect(quotaDay(new Date("2026-11-04T08:30:00Z"))).toBe("2026-11-04");
    expect(quotaCost("videos.insert")).toBeGreaterThan(0);
  });
});
