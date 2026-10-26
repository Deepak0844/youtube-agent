// Password hashing and token helpers. Pure over node:crypto (no IO).
import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";

const N = 32768; // 2^15
const R = 8;
const P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;
// Hard cap on scrypt memory (128*N*r) accepted from a stored value: 64 MiB (current cost is 32 MiB).
const MAX_MEM = 64 * 1024 * 1024;
const MAX_STORED_LEN = 1024;

type Params = { N: number; r: number; p: number; salt: Buffer; key: Buffer };
type Equal = (a: Uint8Array, b: Uint8Array) => boolean;

/** NFKC so equivalent Unicode forms (e.g. NFC vs NFD) hash identically. Applied on hash and verify. */
const norm = (pw: string) => pw.normalize("NFKC");

function derive(pw: string, salt: Uint8Array, keyLen: number, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(norm(pw), salt, keyLen, { N: n, r, p, maxmem: MAX_MEM * 2 }, (e, k) => (e ? reject(e) : resolve(k)));
  });
}

const int = (s: string, lo: number, hi: number): number | null => {
  if (!/^[1-9]\d{0,9}$/.test(s)) return null;
  const v = Number(s);
  return v >= lo && v <= hi ? v : null;
};

function b64(s: string, lo: number, hi: number): Buffer | null {
  if (s.length > 4 * hi) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  const b = Buffer.from(s, "base64");
  if (b.length < lo || b.length > hi || b.toString("base64") !== s) return null;
  return b;
}

/** Strict parse; null for anything malformed or out of bounds. Never throws. */
function parse(stored: unknown): Params | null {
  if (typeof stored !== "string" || stored.length > MAX_STORED_LEN) return null;
  const f = stored.split("$");
  if (f.length !== 6 || f[0] !== "scrypt") return null;
  const [, fn = "", fr = "", fp = "", fs = "", fk = ""] = f;
  const n = int(fn, 2 ** 14, 2 ** 20);
  const r = int(fr, 1, 16);
  const p = int(fp, 1, 4);
  if (n === null || r === null || p === null || (n & (n - 1)) !== 0) return null;
  if (128 * n * r > MAX_MEM) return null;
  const salt = b64(fs, 8, 64);
  const key = b64(fk, 32, 128);
  if (!salt || !key) return null;
  return { N: n, r, p, salt, key };
}

export async function hashPassword(pw: string): Promise<string> {
  if (typeof pw !== "string") throw new TypeError("password must be a string");
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(pw, salt, KEY_BYTES, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/** `opts.equal` is a test-only seam; production always uses crypto.timingSafeEqual. */
export async function verifyPassword(pw: string, stored: string, opts: { equal?: Equal } = {}): Promise<boolean> {
  try {
    if (typeof pw !== "string") return false;
    const s = parse(stored);
    if (!s) return false;
    const key = await derive(pw, s.salt, s.key.length, s.N, s.r, s.p);
    const equal: Equal = opts.equal ?? timingSafeEqual;
    return key.length === s.key.length && equal(key, s.key);
  } catch {
    return false;
  }
}

export function needsRehash(stored: string): boolean {
  const s = parse(stored);
  if (!s) return true;
  return s.N < N || s.r < R || s.p < P || s.salt.length < SALT_BYTES || s.key.length < KEY_BYTES;
}

const DUMMY_SALT = Buffer.alloc(SALT_BYTES, 7);
/** Full-cost scrypt, result discarded: equalises timing for unknown-username paths. */
export async function dummyVerify(): Promise<void> {
  await derive("dummy-password-for-timing", DUMMY_SALT, KEY_BYTES, N, R, P);
}

const sha256hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

export function newToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: sha256hex(token) };
}

export function hashToken(token: string): string {
  if (typeof token !== "string" || token.length === 0 || token.length > 256) throw new RangeError("invalid token");
  return sha256hex(token);
}

// 32 symbols (5 bits each), no 0/O/1/I. 12 chars = 60 bits.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$/;

export function normalizeRecoveryCode(input: string): string | null {
  if (typeof input !== "string" || input.length > 64) return null;
  const n = input.toUpperCase().replace(/-/g, "");
  return CODE_RE.test(n) ? n : null;
}

export function newRecoveryCodes(n = 10): { codes: string[]; hashes: string[] } {
  const codes: string[] = [];
  const hashes: string[] = [];
  const seen = new Set<string>();
  while (codes.length < n) {
    let raw = "";
    for (let i = 0; i < 12; i++) raw += ALPHABET[randomInt(32)];
    if (seen.has(raw)) continue;
    seen.add(raw);
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`);
    hashes.push(sha256hex(raw));
  }
  return { codes, hashes };
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db);
}
