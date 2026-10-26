import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  dummyVerify,
  hashPassword,
  hashToken,
  needsRehash,
  newRecoveryCodes,
  newToken,
  normalizeRecoveryCode,
  timingSafeEqualStr,
  verifyPassword,
} from "@/server/core/auth-crypto";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const b64 = (n: number) => randomBytes(n).toString("base64");
const PW = "correct-horse-battery";

describe("password hashing", () => {
  it("roundtrips, rejects wrong password, salts differ, reports timing", async () => {
    const t0 = performance.now();
    const h = await hashPassword(PW);
    const ms = performance.now() - t0;
    console.log(`hashPassword ms: ${ms.toFixed(0)}`);
    expect(h).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    const [, , , , salt = "", key = ""] = h.split("$");
    expect(Buffer.from(salt, "base64")).toHaveLength(16);
    expect(Buffer.from(key, "base64")).toHaveLength(64);
    expect(await verifyPassword(PW, h)).toBe(true);
    expect(await verifyPassword(PW + "x", h)).toBe(false);
    expect(await verifyPassword("", h)).toBe(false);
    expect(await hashPassword(PW)).not.toBe(h);
    expect(needsRehash(h)).toBe(false);
  });

  it("rejects non-string password on hash; verify returns false", async () => {
    await expect(hashPassword(123 as unknown as string)).rejects.toThrow();
    const h = await hashPassword(PW);
    expect(await verifyPassword(123 as unknown as string, h)).toBe(false);
  });

  it("NFC and NFD forms of the same password match", async () => {
    const nfc = "café-passphrase-1";
    const nfd = "café-passphrase-1";
    expect(nfc).not.toBe(nfd);
    const h = await hashPassword(nfc);
    expect(await verifyPassword(nfd, h)).toBe(true);
    expect(await verifyPassword("cafe-passphrase-1", h)).toBe(false);
  });

  it("honours params embedded in the hash", async () => {
    const salt = randomBytes(16);
    const { scrypt } = await import("node:crypto");
    const key = await new Promise<Buffer>((res, rej) =>
      scrypt(PW.normalize("NFKC"), salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))),
    );
    const stored = `scrypt$16384$8$1$${salt.toString("base64")}$${key.toString("base64")}`;
    expect(await verifyPassword(PW, stored)).toBe(true);
    expect(await verifyPassword("other-password-xyz", stored)).toBe(false);
    expect(needsRehash(stored)).toBe(true);
  });

  it("hostile stored values return false fast without throwing", async () => {
    const good = await hashPassword(PW);
    const p = good.split("$") as [string, string, string, string, string, string];
    const s = b64(16);
    const k = b64(64);
    const cases: unknown[] = [
      "", undefined, null, 42, {}, "scrypt", "garbage",
      good.slice(0, -10),
      good + "$extra",
      [p[0], p[1], p[2], p[3], p[4]].join("$"),
      `scrypt$${2 ** 40}$8$1$${s}$${k}`,
      `scrypt$32768$0$1$${s}$${k}`,
      `scrypt$32768$8$1000$${s}$${k}`,
      `scrypt$32768$1000$1$${s}$${k}`,
      `scrypt$32769$8$1$${s}$${k}`,
      `scrypt$8192$8$1$${s}$${k}`,
      `scrypt$${2 ** 21}$8$1$${s}$${k}`,
      `scrypt$32768$8$1$${b64(100000)}$${k}`,
      `scrypt$32768$8$1$${s}$${b64(100000)}`,
      `scrypt$32768$8$1$${b64(4)}$${k}`,
      `scrypt$32768$8$1$${s}$${b64(8)}`,
      `scrypt$32768$8$1$!!!$${k}`,
      `scrypt$0x8000$8$1$${s}$${k}`,
      `scrypt$32768.0$8$1$${s}$${k}`,
      `scrypt$-32768$8$1$${s}$${k}`,
      `scrypt$NaN$8$1$${s}$${k}`,
      `scrypt$32768$8$1$${s}$` ,
      `bcrypt$32768$8$1$${s}$${k}`,
    ];
    // flip bytes in the key
    const flipped = Buffer.from(p[5], "base64");
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    const flippedStored = [p[0], p[1], p[2], p[3], p[4], flipped.toString("base64")].join("$");
    expect(await verifyPassword(PW, flippedStored)).toBe(false);
    for (const c of cases) {
      const t0 = performance.now();
      let r: boolean | undefined;
      await expect((async () => { r = await verifyPassword(PW, c as string); })()).resolves.toBeUndefined();
      expect(r).toBe(false);
      expect(performance.now() - t0).toBeLessThan(500);
      expect(needsRehash(c as string)).toBe(true);
    }
  });

  it("dummyVerify resolves", async () => {
    await expect(dummyVerify()).resolves.toBeUndefined();
  });

  it("verifyPassword compares with the injected/real timing-safe equal", async () => {
    const h = await hashPassword(PW);
    const equal = vi.fn((a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b)));
    expect(await verifyPassword(PW, h, { equal })).toBe(true);
    expect(equal).toHaveBeenCalledTimes(1);
    const [a, b] = equal.mock.calls[0]!;
    expect(a.length).toBe(b.length);
    expect(a.length).toBe(64);
  });
});

describe("tokens", () => {
  it("43 chars base64url, distinct, hash = sha256 hex", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const { token, tokenHash } = newToken();
      expect(token).toHaveLength(43);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      if (i < 5) expect(tokenHash).toBe(sha(token));
      seen.add(token);
    }
    expect(seen.size).toBe(10_000);
  });
  it("hashToken deterministic and strict", () => {
    const { token } = newToken();
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).toBe(sha(token));
    for (const bad of [undefined, null, 5, {}, "", "a".repeat(257)]) {
      expect(() => hashToken(bad as string)).toThrow(RangeError);
    }
    expect(() => hashToken("a".repeat(256))).not.toThrow();
  });
});

describe("recovery codes", () => {
  it("format, distinct, hashes", () => {
    const { codes, hashes } = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(hashes).toHaveLength(10);
    codes.forEach((c, i) => {
      expect(c).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
      expect(hashes[i]).toBe(sha(c.replace(/-/g, "").toUpperCase()));
      expect(hashes[i]).toBe(sha(normalizeRecoveryCode(c)!));
    });
    expect(newRecoveryCodes(3).codes).toHaveLength(3);
  });
  it("normalises case and hyphens; rejects invalid", () => {
    const c = "ABCD-EFGH-JKMN";
    expect(normalizeRecoveryCode(c)).toBe("ABCDEFGHJKMN");
    expect(normalizeRecoveryCode("abcd-efgh-jkmn")).toBe("ABCDEFGHJKMN");
    expect(normalizeRecoveryCode("abcdefghjkmn")).toBe("ABCDEFGHJKMN");
    for (const bad of ["", "abc", "ABCD-EFGH-JKM0", "ABCD-EFGH-JKMNP", "ABCD-EFGH-JKMO", "ABCD EFGH JKMN", null, 5, undefined, "ABCD-EFGH-JKMN\n"]) {
      expect(normalizeRecoveryCode(bad as string)).toBeNull();
    }
  });
});

describe("timingSafeEqualStr", () => {
  it("equal, unequal, differing length, non-ascii, never throws", () => {
    expect(timingSafeEqualStr("abc", "abc")).toBe(true);
    expect(timingSafeEqualStr("abc", "abd")).toBe(false);
    expect(timingSafeEqualStr("abc", "abcd")).toBe(false);
    expect(timingSafeEqualStr("", "")).toBe(true);
    expect(timingSafeEqualStr("héllo✓", "héllo✓")).toBe(true);
    expect(timingSafeEqualStr("héllo✓", "hello✓")).toBe(false);
    expect(timingSafeEqualStr(1 as unknown as string, "1")).toBe(false);
  });
});
