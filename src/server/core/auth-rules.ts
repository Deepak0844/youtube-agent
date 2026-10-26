// Pure auth rules: no IO, no clock reads (callers pass `now`).

export type PasswordResult = { ok: true } | { ok: false; reason: "too_short" | "common" | "same_as_username" };

export const MIN_PASSWORD_LENGTH = 12;

// Small deny-list of very common passwords (lowercase). Compared case-insensitively.
const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  "123456", "password", "12345678", "qwerty", "123456789", "12345", "1234", "111111", "1234567", "dragon",
  "123123", "baseball", "abc123", "football", "monkey", "letmein", "696969", "shadow", "master", "666666",
  "qwertyuiop", "123321", "mustang", "1234567890", "michael", "654321", "superman", "1qaz2wsx", "7777777", "121212",
  "000000", "qazwsx", "123qwe", "killer", "trustno1", "jordan", "jennifer", "zxcvbnm", "asdfgh", "hunter",
  "buster", "soccer", "harley", "batman", "andrew", "tigger", "sunshine", "iloveyou", "2000", "charlie",
  "robert", "thomas", "hockey", "ranger", "daniel", "starwars", "klaster", "112233", "george", "computer",
  "michelle", "jessica", "pepper", "1111", "zxcvbn", "555555", "11111111", "131313", "freedom", "777777",
  "pass", "maggie", "159753", "aaaaaa", "ginger", "princess", "joshua", "cheese", "amanda", "summer",
  "love", "ashley", "nicole", "chelsea", "biteme", "matthew", "access", "yankees", "987654321", "dallas",
  "austin", "thunder", "taylor", "matrix", "password1", "welcome", "admin", "administrator", "changeme", "qwerty123",
  // Common passwords at or above the 12-character minimum.
  "password123", "password1234", "123456789012", "1234567890123", "qwertyuiop12", "qwertyuiopas", "iloveyou1234",
  "adminadmin12", "administrator1", "letmein12345", "welcome12345", "123456789abc", "abcdefghijkl", "aaaaaaaaaaaa",
  "000000000000", "111111111111", "qwertyuiopasdf", "passwordpassword", "1q2w3e4r5t6y", "q1w2e3r4t5y6",
]);

export function validatePassword(password: string, username: string): PasswordResult {
  if (typeof password !== "string" || [...password].length < MIN_PASSWORD_LENGTH) return { ok: false, reason: "too_short" };
  const folded = password.normalize("NFKC").toLowerCase();
  if (COMMON_PASSWORDS.has(folded)) return { ok: false, reason: "common" };
  if (typeof username === "string" && folded === username.normalize("NFKC").trim().toLowerCase()) {
    return { ok: false, reason: "same_as_username" };
  }
  return { ok: true };
}

const LOCKOUT_FREE_FAILURES = 5;
const LOCKOUT_BASE_MS = 60_000;
const LOCKOUT_CAP_MS = 3_600_000;

// 0 until 5 failures; 5 -> 60s, then doubling per extra failure, capped at 1 h.
export function lockoutDelayMs(recentFailures: number): number {
  if (!Number.isInteger(recentFailures) || recentFailures < 0) throw new RangeError("recentFailures must be a non-negative integer");
  if (recentFailures < LOCKOUT_FREE_FAILURES) return 0;
  const exp = Math.min(recentFailures - LOCKOUT_FREE_FAILURES, 20); // 2^20 * 60s already far above the cap; avoids Infinity
  return Math.min(LOCKOUT_BASE_MS * 2 ** exp, LOCKOUT_CAP_MS);
}

// NFKC, trim, lowercase, then NFKC again (lowercasing can produce new composable sequences). Only ASCII [a-z0-9._-], 3-64 chars.
// Anything else (including look-alike Unicode that survives NFKC) returns null.
export function normalizeUsername(input: string): string | null {
  if (typeof input !== "string") return null;
  const n = input.normalize("NFKC").trim().toLowerCase().normalize("NFKC");
  return /^[a-z0-9._-]{3,64}$/.test(n) ? n : null;
}

export const SESSION_IDLE_MS = 8 * 3_600_000;
export const SESSION_ABSOLUTE_MS = 7 * 24 * 3_600_000;

function validDate(d: unknown, name: string): number {
  const t = d instanceof Date ? d.getTime() : NaN;
  if (!Number.isFinite(t)) throw new RangeError(`${name} must be a valid Date`);
  return t;
}

// Expired when elapsed >= limit. Idle runs from lastSeenAt, absolute from createdAt.
// A lastSeenAt in the future (clock skew) counts as just seen; lastSeenAt before createdAt is invalid.
export function sessionExpiry(now: Date, createdAt: Date, lastSeenAt: Date): { idleExpired: boolean; absoluteExpired: boolean } {
  const n = validDate(now, "now");
  const c = validDate(createdAt, "createdAt");
  const l = validDate(lastSeenAt, "lastSeenAt");
  if (l < c) throw new RangeError("lastSeenAt is before createdAt");
  return { idleExpired: n - l >= SESSION_IDLE_MS, absoluteExpired: n - c >= SESSION_ABSOLUTE_MS };
}
