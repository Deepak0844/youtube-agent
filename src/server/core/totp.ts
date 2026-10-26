// TOTP (RFC 6238) and HOTP (RFC 4226), SHA-1, 6 digits, 30 s. Pure over node:crypto (no IO).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_MS = 30_000;
const MAX_SECRET_CHARS = 128;

export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const b of buf) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += A[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += A[(acc << (5 - bits)) & 31];
  return out;
}

/** Strict RFC 4648 upper-case, unpadded. null on bad chars, padding, impossible length or non-zero trailing bits. */
export function base32Decode(s: string): Buffer | null {
  if (typeof s !== "string" || s.length === 0 || s.length > MAX_SECRET_CHARS) return null;
  if (!/^[A-Z2-7]+$/.test(s)) return null;
  if ([1, 3, 6].includes(s.length % 8)) return null;
  const out: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const ch of s) {
    acc = (acc << 5) | A.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 255);
      bits -= 8;
    }
    acc &= (1 << bits) - 1;
  }
  if (acc !== 0) return null; // leftover padding bits must be zero (canonical)
  return Buffer.from(out);
}

export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

function hotpKey(key: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", key).update(msg).digest();
  const o = (h[19] as number) & 15;
  const bin = (((h[o] as number) & 0x7f) << 24) | (((h[o + 1] as number) & 255) << 16) | (((h[o + 2] as number) & 255) << 8) | ((h[o + 3] as number) & 255);
  return String(bin % 1_000_000).padStart(6, "0");
}

export function hotp(secretB32: string, counter: number): string {
  const key = base32Decode(secretB32);
  if (!key) throw new RangeError("invalid secret");
  if (!Number.isSafeInteger(counter) || counter < 0) throw new RangeError("invalid counter");
  return hotpKey(key, counter);
}

export const totpStep = (timeMs: number): number => Math.floor(timeMs / STEP_MS);

export function totpCode(secretB32: string, timeMs: number): string {
  return hotp(secretB32, totpStep(timeMs));
}

export function verifyTotp(
  secretB32: string,
  code: string,
  nowMs: number,
  lastUsedStep: number | null,
): { ok: true; step: number } | { ok: false } {
  try {
    if (typeof code !== "string" || code.length > 32) return { ok: false };
    const c = code.trim().replace(/ /g, "");
    if (!/^\d{6}$/.test(c)) return { ok: false };
    const key = base32Decode(secretB32);
    if (!key || !Number.isFinite(nowMs)) return { ok: false };
    const base = totpStep(nowMs);
    const given = Buffer.from(c);
    // Compute and compare all three candidates before deciding: no early exit on a match.
    let matched = -1;
    for (const d of [-1, 0, 1]) {
      const step = base + d;
      if (step < 0) continue;
      const eq = timingSafeEqual(given, Buffer.from(hotpKey(key, step)));
      const fresh = lastUsedStep === null || step > lastUsedStep;
      if (eq && fresh && step > matched) matched = step;
    }
    return matched >= 0 ? { ok: true, step: matched } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export function otpauthUri(secretB32: string, username: string, issuer: string): string {
  const e = encodeURIComponent;
  return `otpauth://totp/${e(issuer)}:${e(username)}?secret=${e(secretB32)}&issuer=${e(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
