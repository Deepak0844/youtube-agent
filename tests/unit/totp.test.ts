import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, generateSecret, hotp, otpauthUri, totpCode, verifyTotp } from "@/server/core/totp";

const ASCII = Buffer.from("12345678901234567890");
const SECRET = base32Encode(ASCII);

describe("hotp (RFC 4226 Appendix D)", () => {
  const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
  it.each(expected.map((e, i) => [i, e] as const))("counter %i", (c, e) => {
    expect(hotp(SECRET, c)).toBe(e);
  });
});

describe("totp (RFC 6238 Appendix B, SHA-1, last 6 digits)", () => {
  const vectors: [number, string][] = [
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
    [20000000000, "353130"],
  ];
  it.each(vectors)("t=%i", (t, e) => {
    expect(totpCode(SECRET, t * 1000)).toBe(e);
  });
});

describe("verifyTotp", () => {
  const now = 1_111_111_111_000; // step 37037037
  const step = Math.floor(now / 30000);
  const at = (s: number) => totpCode(SECRET, s * 30000);
  it("accepts current, -1, +1", () => {
    expect(verifyTotp(SECRET, at(step), now, null)).toEqual({ ok: true, step });
    expect(verifyTotp(SECRET, at(step - 1), now, null)).toEqual({ ok: true, step: step - 1 });
    expect(verifyTotp(SECRET, at(step + 1), now, null)).toEqual({ ok: true, step: step + 1 });
  });
  it("rejects +-2", () => {
    expect(verifyTotp(SECRET, at(step - 2), now, null)).toEqual({ ok: false });
    expect(verifyTotp(SECRET, at(step + 2), now, null)).toEqual({ ok: false });
  });
  it("rejects replay and older steps, accepts newer", () => {
    expect(verifyTotp(SECRET, at(step), now, step)).toEqual({ ok: false });
    expect(verifyTotp(SECRET, at(step - 1), now, step)).toEqual({ ok: false });
    expect(verifyTotp(SECRET, at(step + 1), now, step)).toEqual({ ok: true, step: step + 1 });
    expect(verifyTotp(SECRET, at(step), now, step - 1)).toEqual({ ok: true, step });
  });
  it("accepts spaces, rejects bad shapes", () => {
    const c = at(step);
    expect(verifyTotp(SECRET, ` ${c.slice(0, 3)} ${c.slice(3)} `, now, null).ok).toBe(true);
    for (const bad of ["", "12345", "1234567", "12345a", "١٢٣٤٥٦", c + "0", "-12345"]) {
      expect(verifyTotp(SECRET, bad, now, null)).toEqual({ ok: false });
    }
    expect(verifyTotp(SECRET, 123456 as unknown as string, now, null)).toEqual({ ok: false });
  });
  it("invalid secret is ok:false, never throws", () => {
    for (const s of ["", "not base32!", "abc", "A", null as unknown as string]) {
      expect(verifyTotp(s, "123456", now, null)).toEqual({ ok: false });
    }
  });
  it("bad time or lastUsedStep does not throw", () => {
    expect(verifyTotp(SECRET, at(step), Number.NaN, null)).toEqual({ ok: false });
  });
});

describe("base32 / secret", () => {
  it("generateSecret is 32 uppercase chars, unique, 20 bytes", () => {
    const s = generateSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(s)?.length).toBe(20);
    expect(generateSecret()).not.toBe(s);
  });
  it("round trips and matches RFC 4648 vectors", () => {
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Decode("MZXW6YTBOI")?.toString()).toBe("foobar");
    for (let n = 1; n < 40; n++) {
      const b = Buffer.alloc(n, n * 7);
      expect(base32Decode(base32Encode(b))?.equals(b)).toBe(true);
    }
  });
  it("strict decode rejects", () => {
    for (const bad of ["", "mzxw6ytboi", "MZXW6YTBOI======", "MZXW6YT=", "MZXW 6YT", "MZXW1YTB", "MZXW6YTB0I", "M", "MZX", "MZXW6Y", "MZXW6YTBOJ"]) {
      expect(base32Decode(bad), bad).toBeNull();
    }
  });
});

describe("otpauthUri", () => {
  it("has the expected shape", () => {
    expect(otpauthUri("ABC234", "alice", "YT Studio")).toBe(
      "otpauth://totp/YT%20Studio:alice?secret=ABC234&issuer=YT%20Studio&algorithm=SHA1&digits=6&period=30",
    );
  });
  it("percent-encodes special characters", () => {
    const u = otpauthUri("ABC234", "a b:c/d?e&f#g@h", "Is&su:er?x=y");
    expect(u).toBe(
      "otpauth://totp/Is%26su%3Aer%3Fx%3Dy:a%20b%3Ac%2Fd%3Fe%26f%23g%40h?secret=ABC234&issuer=Is%26su%3Aer%3Fx%3Dy&algorithm=SHA1&digits=6&period=30",
    );
    const p = new URL(u);
    expect(p.searchParams.get("issuer")).toBe("Is&su:er?x=y");
    expect(p.searchParams.get("secret")).toBe("ABC234");
  });
});
