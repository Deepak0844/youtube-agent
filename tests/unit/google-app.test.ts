import { describe, expect, it } from "vitest";
import { CALLBACK_PATH, maskClientId, redirectUriFor, validateClientId, validateClientSecret, validateRedirectUri, googleAppInput } from "@/server/core/google-app";

const ID = "123456789012-abcdefghijklmnopqrstuv12.apps.googleusercontent.com";

describe("validateClientId", () => {
  it("accepts the Google shape", () => expect(validateClientId(ID)).toEqual({ ok: true, value: ID }));
  it("trims", () => expect(validateClientId(`  ${ID}\n`)).toMatchObject({ ok: true, value: ID }));
  it.each(["", "abc", "123.apps.googleusercontent.com", "1234567-abcdefgh.apps.googleusercontent.com.evil.com", "https://x-abcdefgh.apps.googleusercontent.com", "1234567-abc defgh.apps.googleusercontent.com", "1234567-abcdefgh.apps.google.com"])("rejects %j", (v) => {
    expect(validateClientId(v).ok).toBe(false);
  });
});

describe("validateClientSecret", () => {
  it("accepts a plausible secret", () => expect(validateClientSecret("GOCSPX-abcdefghijklmnop12345678901").ok).toBe(true));
  it.each(["", "short", "has space inside 12345", "x".repeat(300), "tab\tinside1234567"])("rejects %j without echoing it", (v) => {
    const r = validateClientSecret(v);
    expect(r.ok).toBe(false);
    if (!r.ok && v.length > 4) expect(r.error).not.toContain(v);
  });
});

describe("redirect URI", () => {
  it("defaults to localhost:3000", () => expect(redirectUriFor(undefined)).toEqual({ ok: true, uri: `http://localhost:3000${CALLBACK_PATH}` }));
  it("derives from APP_URL, dropping trailing slash and path", () => {
    expect(redirectUriFor("https://studio.example.com/")).toEqual({ ok: true, uri: `https://studio.example.com${CALLBACK_PATH}` });
    expect(redirectUriFor("http://127.0.0.1:3000/x")).toMatchObject({ ok: true, uri: `http://127.0.0.1:3000${CALLBACK_PATH}` });
  });
  it.each(["http://studio.example.com", "ftp://localhost", "javascript:alert(1)", "http://10.0.0.5:3000", "https://user:pw@example.com", "nope", "http://localhost.evil.com"])("refuses %j", (v) => {
    expect(redirectUriFor(v).ok).toBe(false);
  });
  it("validateRedirectUri requires the exact callback path", () => {
    expect(validateRedirectUri(`https://a.example.com${CALLBACK_PATH}`)).toBe(true);
    expect(validateRedirectUri("https://a.example.com/other")).toBe(false);
    expect(validateRedirectUri(`http://a.example.com${CALLBACK_PATH}`)).toBe(false);
  });
});

describe("maskClientId", () => {
  it("hides the middle but keeps the suffix", () => {
    const m = maskClientId(ID);
    expect(m.startsWith("1234")).toBe(true);
    expect(m.endsWith(".apps.googleusercontent.com")).toBe(true);
    expect(m).not.toContain("abcdefghijklmnop");
  });
});

describe("googleAppInput", () => {
  it("needs both when nothing is stored", () => expect(googleAppInput({ clientId: "", clientSecret: "" }, { hasId: false, hasSecret: false }).ok).toBe(false));
  it("blank fields with everything stored means nothing to save", () => expect(googleAppInput({ clientId: "", clientSecret: "" }, { hasId: true, hasSecret: true }).ok).toBe(false));
  it("secret only is fine when the id is stored", () => expect(googleAppInput({ clientId: "", clientSecret: "GOCSPX-abcdefghijklmnop12345678901" }, { hasId: true, hasSecret: true })).toMatchObject({ ok: true }));
  it("bad id is a field error, bad secret never echoed", () => {
    const r = googleAppInput({ clientId: "bad", clientSecret: "short secret" }, { hasId: false, hasSecret: false });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(Object.keys(r.fieldErrors).sort()).toEqual(["clientId", "clientSecret"]);
      expect(JSON.stringify(r)).not.toContain("short secret");
    }
  });
});
