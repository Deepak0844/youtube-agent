import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// API tokens for /api/v1 (Phase 7). Pure: no IO. The secret is 32 random bytes; only its SHA-256 is stored (a fast hash is
// right for a high-entropy secret). HARD RULES live in the shape of the code, not in a check someone could forget:
//  - tokens are accepted ONLY by requireTokenApi (src/lib/auth/require-token.ts), which only /api/v1 routes may import;
//  - the only scopes are `read` and `create_draft`: no scope exists for gates, safety settings, keys, settings or tokens.

export const TOKEN_SCOPES = ["read", "create_draft"] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

export const SCOPE_LABEL: Record<TokenScope, string> = {
  read: "Read status",
  create_draft: "Create drafts",
};

export const MAX_DAILY_CAP = 100;
export const DEFAULT_DAILY_CAP = 5;
export const PREFIX_LEN = 12; // "yts_" + 8 characters

const TOKEN_RE = /^yts_[A-Za-z0-9_-]{43}$/;

export function generateToken(random: (n: number) => Buffer = randomBytes): { secret: string; prefix: string; hash: Buffer } {
  const secret = "yts_" + random(32).toString("base64url");
  return { secret, prefix: secret.slice(0, PREFIX_LEN), hash: hashToken(secret) };
}

export const hashToken = (secret: string): Buffer => createHash("sha256").update(secret, "utf8").digest();

/** Constant-time compare of two hashes. Different lengths are simply unequal (never throws). */
export function hashesEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** "Bearer <token>" from an Authorization header value; null for anything else (wrong scheme, wrong shape, extra parts). */
export function parseBearer(header: string | null | undefined): string | null {
  if (typeof header !== "string" || header.length > 200) return null;
  const m = /^Bearer ([^\s]+)$/i.exec(header);
  const t = m?.[1];
  return t !== undefined && TOKEN_RE.test(t) ? t : null;
}

export const prefixOf = (secret: string): string => secret.slice(0, PREFIX_LEN);

export const isScope = (s: unknown): s is TokenScope => typeof s === "string" && (TOKEN_SCOPES as readonly string[]).includes(s);

export type NewTokenInput = { name: string; scopes: TokenScope[]; dailyDraftCap: number };

/** Validates form input. Unknown scopes are an error, never ignored. */
export function parseNewToken(raw: { name: unknown; scopes: unknown[]; cap: unknown }): { ok: true; value: NewTokenInput } | { ok: false; error: string } {
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (name.length < 1 || name.length > 60) return { ok: false, error: "Give the token a name of 1 to 60 characters." };
  if (!raw.scopes.every(isScope)) return { ok: false, error: "Unknown permission." };
  const scopes = [...new Set(raw.scopes as TokenScope[])];
  if (scopes.length < 1) return { ok: false, error: "Pick at least one permission." };
  const cap = typeof raw.cap === "string" && /^\d{1,3}$/.test(raw.cap.trim()) ? Number(raw.cap.trim()) : typeof raw.cap === "number" ? raw.cap : NaN;
  if (!Number.isInteger(cap) || cap < 0 || cap > MAX_DAILY_CAP) return { ok: false, error: `The daily draft limit must be a whole number from 0 to ${MAX_DAILY_CAP}.` };
  if (cap === 0 && scopes.includes("create_draft")) return { ok: false, error: "A token that may create drafts needs a daily limit of at least 1." };
  return { ok: true, value: { name, scopes, dailyDraftCap: cap } };
}
