import { describe, expect, it } from "vitest";
import { lockoutDelayMs, normalizeUsername, sessionExpiry, validatePassword } from "@/server/core/auth-rules";

describe("validatePassword", () => {
  const good = "correct-horse-battery";
  it.each([
    ["a".repeat(11), "too_short"],
    ["", "too_short"],
    ["password1234", "common"],
    ["PASSWORD1234", "common"],
    ["qwertyuiop", "too_short"],
    ["123456789012", "common"],
    ["Ownername-123", "same_as_username"],
  ])("rejects %s", (pw, reason) => {
    expect(validatePassword(pw, pw === "Ownername-123" ? "ownername-123" : "someone")).toEqual({ ok: false, reason });
  });
  it("accepts exactly 12 chars that are not common", () => {
    expect(validatePassword("Zx9!qLm2#vTb", "someone")).toEqual({ ok: true });
  });
  it("accepts a long passphrase", () => {
    expect(validatePassword(good, "someone")).toEqual({ ok: true });
  });
  it("length counts code points, not UTF-16 units (11 emoji is too short)", () => {
    expect(validatePassword("😀".repeat(11), "x")).toEqual({ ok: false, reason: "too_short" });
    expect(validatePassword("😀".repeat(12), "x")).toEqual({ ok: true });
  });
  it("username equality is case-insensitive", () => {
    expect(validatePassword("Owner-Account-1", "owner-account-1")).toEqual({ ok: false, reason: "same_as_username" });
  });
  it("non-string input is rejected, never throws", () => {
    expect(validatePassword(undefined as unknown as string, "x")).toEqual({ ok: false, reason: "too_short" });
  });
});

describe("lockoutDelayMs", () => {
  it.each([
    [0, 0], [1, 0], [4, 0], [5, 60_000], [6, 120_000], [7, 240_000], [8, 480_000],
    [9, 960_000], [10, 1_920_000], [11, 3_600_000], [12, 3_600_000], [1000, 3_600_000], [1e9, 3_600_000],
  ])("%i failures -> %i ms", (n, ms) => {
    expect(lockoutDelayMs(n)).toBe(ms);
  });
  it.each([-1, NaN, 1.5, Infinity])("invalid count %s throws RangeError", (n) => {
    expect(() => lockoutDelayMs(n)).toThrow(RangeError);
  });
});

describe("normalizeUsername (sign-in email)", () => {
  it.each([
    ["Owner@Example.com", "owner@example.com"],
    ["  admin.user_1+yt@mail.example.co.in  ", "admin.user_1+yt@mail.example.co.in"],
    ["a@b.co", "a@b.co"],
    ["\uFF21@\uFF22.co", "a@b.co"], // fullwidth folds to ascii under NFKC
    [`${"a".repeat(64)}@x.io`, `${"a".repeat(64)}@x.io`],
  ])("accepts %s", (input, out) => {
    expect(normalizeUsername(input)).toBe(out);
  });
  it.each([
    "owner", "", "   ", "@b.co", "a@", "a@b", "a@b.", "a@.co", "a@-b.co", "a@b-.co", "a b@c.co", "a@@b.co", `${"a".repeat(65)}@x.io`,
    `a@${"b".repeat(250)}.co`, "o\u0441ner@x.co", "adm\u200Bin@x.co", "ad\u0000min@x.co", "ad\nmin@x.co", "caf\u00E9@x.co", "a/b@x.co",
  ])("rejects %j", (input) => {
    expect(normalizeUsername(input)).toBeNull();
  });
  it("Kelvin sign folds to ascii k under NFKC (accepted as the folded value)", () => {
    expect(normalizeUsername("xx\u212A@x.co")).toBe("xxk@x.co");
  });
  it("is idempotent", () => {
    const n = normalizeUsername("  \uFF2Fwner@X.co ")!;
    expect(normalizeUsername(n)).toBe(n);
  });
  it("non-string returns null", () => {
    expect(normalizeUsername(undefined as unknown as string)).toBeNull();
  });
});

describe("sessionExpiry", () => {
  const H = 3_600_000;
  const created = new Date("2026-01-01T00:00:00Z");
  const at = (ms: number) => new Date(created.getTime() + ms);
  it("idle: not expired just before 8h, expired exactly at 8h", () => {
    expect(sessionExpiry(at(8 * H - 1), created, created).idleExpired).toBe(false);
    expect(sessionExpiry(at(8 * H), created, created).idleExpired).toBe(true);
    expect(sessionExpiry(at(8 * H + 1), created, created).idleExpired).toBe(true);
  });
  it("absolute: not expired just before 7d, expired exactly at 7d", () => {
    const d = 24 * H;
    expect(sessionExpiry(at(7 * d - 1), created, at(7 * d - 2)).absoluteExpired).toBe(false);
    expect(sessionExpiry(at(7 * d), created, at(7 * d - 1)).absoluteExpired).toBe(true);
  });
  it("idle is measured from lastSeenAt, absolute from createdAt", () => {
    const r = sessionExpiry(at(10 * H), created, at(5 * H));
    expect(r).toEqual({ idleExpired: false, absoluteExpired: false });
  });
  it("last seen in the future (clock skew) is not expired", () => {
    expect(sessionExpiry(at(0), created, at(H)).idleExpired).toBe(false);
  });
  it("lastSeenAt before createdAt is a RangeError", () => {
    expect(() => sessionExpiry(at(H), at(H), created)).toThrow(RangeError);
  });
  it("invalid dates throw RangeError", () => {
    const bad = new Date("nope");
    expect(() => sessionExpiry(bad, created, created)).toThrow(RangeError);
    expect(() => sessionExpiry(created, bad, created)).toThrow(RangeError);
    expect(() => sessionExpiry(created, created, bad)).toThrow(RangeError);
    expect(() => sessionExpiry("2026" as unknown as Date, created, created)).toThrow(RangeError);
  });
});
