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
  it("derives from APP_URL (a trailing slash is fine)", () => {
    expect(redirectUriFor("https://studio.example.com/")).toEqual({ ok: true, uri: `https://studio.example.com${CALLBACK_PATH}` });
    expect(redirectUriFor("http://127.0.0.1:3000")).toMatchObject({ ok: true, uri: `http://127.0.0.1:3000${CALLBACK_PATH}` });
  });
  it("refuses an APP_URL that has a path, query or fragment, with a clear message (never silently drops it)", () => {
    for (const v of ["http://127.0.0.1:3000/x", "https://studio.example.com/studio", "https://studio.example.com/?a=1", "https://studio.example.com/#f"]) {
      const r = redirectUriFor(v);
      expect(r.ok, v).toBe(false);
      if (!r.ok) expect(r.error).toContain("no path");
    }
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

describe("maskClientId case", () => {
  it("masks an upper-case id the same way (the id check is case-insensitive)", () => {
    const up = ID.toUpperCase();
    expect(validateClientId(up).ok).toBe(true);
    const m = maskClientId(up);
    expect(m).not.toBe("…");
    expect(m.startsWith("1234")).toBe(true);
    expect(m).not.toContain("ABCDEFGHIJKLMNOP");
    expect(m.toLowerCase().endsWith(".apps.googleusercontent.com")).toBe(true);
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

describe("pasted input", () => {
  const SEC = "GOCSPX-abcdefghijklmnop12345678901";
  const stored = { hasId: true, hasSecret: true };
  it("strips ONE trailing newline or space from a pasted secret, nothing else", () => {
    for (const t of [`${SEC}\n`, `${SEC}\r\n`, `${SEC} `]) expect(googleAppInput({ clientId: "", clientSecret: t }, stored)).toEqual({ ok: true, clientSecret: SEC });
    expect(googleAppInput({ clientId: "", clientSecret: `${SEC}\n\n` }, stored).ok).toBe(false);
    expect(googleAppInput({ clientId: "", clientSecret: `${SEC}  ` }, stored).ok).toBe(false);
    expect(googleAppInput({ clientId: "", clientSecret: ` ${SEC}` }, stored).ok).toBe(false);
  });
  it("a lone newline in the secret box counts as empty", () => {
    expect(googleAppInput({ clientId: "", clientSecret: "\n" }, stored)).toMatchObject({ ok: false, fieldErrors: { form: expect.any(String) } });
  });
  it("an over-long secret or id is a field error, never a silent keep", () => {
    const r = googleAppInput({ clientId: "a".repeat(400), clientSecret: "s".repeat(400) }, stored);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.fieldErrors).sort()).toEqual(["clientId", "clientSecret"]);
    expect(googleAppInput({ clientId: `${"a".repeat(101)}.apps.googleusercontent.com`, clientSecret: "" }, stored).ok).toBe(false);
  });
  it("a secret with & \" % is accepted as is (Phase 5 must form-encode it)", () => {
    const odd = 'GOCSPX-a&b"c%d+e/f=g12345678901';
    expect(googleAppInput({ clientId: "", clientSecret: odd }, stored)).toEqual({ ok: true, clientSecret: odd });
  });
});

