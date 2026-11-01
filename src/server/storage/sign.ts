import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizeRelPath } from "./paths";

// Signed media URLs. The signature IS the credential for GET /api/media/... (no cookie is needed or looked at).
//   /api/media/<path>?e=<unix seconds>&s=<base64url HMAC-SHA256 over "GET\n" + path + "\n" + e>
// `path` is relative to the storage root, strict (see normalizeRelPath), and is the DECODED form that is signed. The key
// is the vault secret `media.signing` (see db/media-key.ts). Pure functions: the clock and the key are arguments.

export const DEFAULT_LIFETIME_SEC = 4 * 3600;
const KEY_BYTES = 32;
const SIG_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url, no padding
const EXP_RE = /^[1-9][0-9]{0,11}$/; // canonical positive integer (no sign, no leading zero, no exponent, no spaces)

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length < KEY_BYTES) throw new Error("media signing key must be at least 32 bytes");
}

function mac(relPath: string, exp: number | string, key: Buffer): Buffer {
  return createHmac("sha256", key).update(`GET\n${relPath}\n${exp}`).digest();
}

export function signMediaUrl(relPath: string, expiresAtSec: number, key: Buffer): string {
  assertKey(key);
  if (normalizeRelPath(relPath) === null) throw new Error("invalid media path");
  if (!Number.isSafeInteger(expiresAtSec) || expiresAtSec < 1) throw new Error("invalid expiry");
  const sig = mac(relPath, expiresAtSec, key).toString("base64url");
  const encoded = relPath.split("/").map(encodeURIComponent).join("/");
  return `/api/media/${encoded}?e=${expiresAtSec}&s=${sig}`;
}

export type VerifyResult = { ok: true; path: string; exp: number } | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

/**
 * Everything that can be decided WITHOUT the key: query shapes, path format, and expiry on the caller's clock. The route
 * runs this first so junk and expired requests never cost a database read or a vault decrypt. Expiry here is not an
 * oracle: every failure is answered alike.
 */
export function precheckMediaUrl(input: { path: string; e: string | null; s: string | null }, nowSec: number): { ok: true; path: string; exp: number } | { ok: false; reason: "malformed" | "expired" } {
  const { path: relPath, e, s } = input;
  if (typeof e !== "string" || !EXP_RE.test(e) || typeof s !== "string" || !SIG_RE.test(s)) return { ok: false, reason: "malformed" };
  if (normalizeRelPath(relPath) === null) return { ok: false, reason: "malformed" };
  const exp = Number(e);
  if (!Number.isSafeInteger(exp)) return { ok: false, reason: "malformed" };
  if (nowSec >= exp) return { ok: false, reason: "expired" };
  return { ok: true, path: relPath, exp };
}

/**
 * Order matters: shape checks, then the MAC (constant time), then expiry on the caller's clock (`nowSec`). A URL is dead
 * AT its expiry second (`now >= exp`). Failure reasons are for tests and logs only; callers must answer all of them alike.
 */
export function verifyMediaUrl(input: { path: string; e: string | null; s: string | null }, key: Buffer, nowSec: number): VerifyResult {
  assertKey(key);
  const { path: relPath, e, s } = input;
  if (typeof e !== "string" || !EXP_RE.test(e) || typeof s !== "string" || !SIG_RE.test(s)) return { ok: false, reason: "malformed" };
  if (normalizeRelPath(relPath) === null) return { ok: false, reason: "malformed" };
  const exp = Number(e);
  if (!Number.isSafeInteger(exp)) return { ok: false, reason: "malformed" };
  const given = Buffer.from(s, "base64url");
  const want = mac(relPath, e, key);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return { ok: false, reason: "bad_signature" };
  if (nowSec >= exp) return { ok: false, reason: "expired" };
  return { ok: true, path: relPath, exp };
}

/**
 * For pages that hold a URL for a while. Returns the same URL while it has more than `thresholdSec` left, a fresh one
 * when it is near (or past) expiry, and null when the URL is not an authentic one of ours (a forged URL is never
 * "laundered" into a valid one). An authentic but expired URL is renewed: only server code can call this.
 */
export function resignIfNear(url: string, nowSec: number, thresholdSec: number, key: Buffer, lifetimeSec: number = DEFAULT_LIFETIME_SEC): string | null {
  assertKey(key);
  let u: URL;
  try {
    u = new URL(url, "http://media.invalid");
  } catch {
    return null;
  }
  const prefix = "/api/media/";
  if (!u.pathname.startsWith(prefix)) return null;
  let rel: string;
  try {
    rel = u.pathname.slice(prefix.length).split("/").map(decodeURIComponent).join("/");
  } catch {
    return null;
  }
  const r = verifyMediaUrl({ path: rel, e: u.searchParams.get("e"), s: u.searchParams.get("s") }, key, 0); // clock 0: authenticity only
  if (!r.ok) return null;
  if (r.exp - nowSec > thresholdSec) return url;
  return signMediaUrl(rel, nowSec + lifetimeSec, key);
}

/**
 * An expiry that is identical for every call inside one `windowSec` window, so the same file signs to the same URL and a
 * playing <video> is not reloaded by a page refresh. Always at least `minTtlSec` away, at most `windowSec + minTtlSec`.
 */
export function stableExpiry(nowSec: number, windowSec: number, minTtlSec: number): number {
  return Math.ceil((nowSec + minTtlSec) / windowSec) * windowSec;
}
