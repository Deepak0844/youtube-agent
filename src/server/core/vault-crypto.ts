// Secrets vault crypto: AES-256-GCM with injected keys. Pure over node:crypto (no IO); the DB side lives in server/db/vault.ts.
// Stored record = { ciphertext (data || 16-byte tag), nonce (12 random bytes, fresh per encryption), keyId }.
// AAD binds format version + keyId + secret name, so a ciphertext cannot be moved to another name or relabelled to another key.
// Errors are generic on purpose: they never carry plaintext, key material, ciphertext, or the secret name.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_PLAIN_BYTES = 64 * 1024;
const AAD_PREFIX = "ytstudio-vault:v1";

export type VaultErrorCode = "bad_key" | "wrong_key" | "decrypt_failed" | "bad_input" | "not_found";
const MESSAGES: Record<VaultErrorCode, string> = {
  bad_key: "vault: master key is missing or malformed",
  wrong_key: "vault: no matching master key for this secret",
  decrypt_failed: "vault: secret could not be decrypted",
  bad_input: "vault: invalid input",
  not_found: "vault: no such secret",
};

export class VaultError extends Error {
  readonly code: VaultErrorCode;
  constructor(code: VaultErrorCode) {
    super(MESSAGES[code]);
    this.name = "VaultError";
    this.code = code;
  }
}

export interface VaultKey {
  id: string;
  key: Buffer;
}
export interface Keyring {
  current: VaultKey;
  byId: ReadonlyMap<string, VaultKey>;
}
export interface SealedSecret {
  ciphertext: Buffer;
  nonce: Buffer;
  keyId: string;
}

export function generateMasterKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

/** Strict base64 of exactly 32 bytes. Never echoes the input in the error. */
export function parseMasterKey(b64: string): Buffer {
  if (typeof b64 !== "string" || b64.length !== 44 || !/^[A-Za-z0-9+/]{43}=$/.test(b64)) throw new VaultError("bad_key");
  const key = Buffer.from(b64, "base64");
  if (key.length !== KEY_BYTES || key.toString("base64") !== b64) throw new VaultError("bad_key");
  return key;
}

/** First 8 hex chars of SHA-256 over a domain-separated hash of the key: a label for rotation, not usable to recover the key. */
export function keyIdOf(key: Buffer): string {
  return createHash("sha256").update("ytstudio-vault-key-id:").update(key).digest("hex").slice(0, 8);
}

/** `current` encrypts and decrypts; the optional `previous` key only decrypts (rotation window). */
export function makeKeyring(currentB64: string, previousB64?: string): Keyring {
  const mk = (b64: string): VaultKey => {
    const key = parseMasterKey(b64);
    return { id: keyIdOf(key), key };
  };
  const current = mk(currentB64);
  const byId = new Map<string, VaultKey>([[current.id, current]]);
  if (previousB64) {
    const prev = mk(previousB64);
    if (byId.has(prev.id)) throw new VaultError("bad_key");
    byId.set(prev.id, prev);
  }
  return { current, byId };
}

// KNOWN RESIDUAL RISK (rollback): the AAD binds name and key id but not a version or timestamp. Anyone who can write the
// secrets table can restore an OLDER ciphertext for the SAME name (e.g. a rotated-out provider key) and it will still
// authenticate and decrypt. GCM cannot detect this; defend with DB access control and backup hygiene, not crypto.
const aad = (keyId: string, name: string) => Buffer.from(`${AAD_PREFIX}\0${keyId}\0${name}`, "utf8");

function checkName(name: string): void {
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(name)) throw new VaultError("bad_input");
}

export function encryptSecret(ring: Keyring, name: string, plain: string): SealedSecret {
  checkName(name);
  if (typeof plain !== "string" || Buffer.byteLength(plain, "utf8") > MAX_PLAIN_BYTES) throw new VaultError("bad_input");
  const { id, key } = ring.current;
  const nonce = randomBytes(NONCE_BYTES);
  const c = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  c.setAAD(aad(id, name));
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return { ciphertext: Buffer.concat([body, c.getAuthTag()]), nonce, keyId: id };
}

/** Throws VaultError on a wrong key, tamper, truncation or name mismatch; never returns a partial or empty value on failure. */
export function decryptSecret(ring: Keyring, name: string, rec: SealedSecret): string {
  checkName(name);
  const k = ring.byId.get(rec.keyId);
  if (!k) throw new VaultError("wrong_key");
  if (!Buffer.isBuffer(rec.nonce) || rec.nonce.length !== NONCE_BYTES) throw new VaultError("decrypt_failed");
  if (!Buffer.isBuffer(rec.ciphertext) || rec.ciphertext.length < TAG_BYTES) throw new VaultError("decrypt_failed");
  try {
    const d = createDecipheriv("aes-256-gcm", k.key, rec.nonce, { authTagLength: TAG_BYTES });
    d.setAAD(aad(rec.keyId, name));
    d.setAuthTag(rec.ciphertext.subarray(rec.ciphertext.length - TAG_BYTES));
    return Buffer.concat([d.update(rec.ciphertext.subarray(0, rec.ciphertext.length - TAG_BYTES)), d.final()]).toString("utf8");
  } catch {
    throw new VaultError("decrypt_failed"); // the underlying error is dropped on purpose
  }
}

const HINT_MIN_CHARS = 24;
const NO_HINT_PREFIXES = ["totp.", "owner."];

/** Names whose secrets are short or high-value (TOTP seeds, owner credentials): they never get a stored hint. */
export function hintAllowedFor(name: string): boolean {
  return !NO_HINT_PREFIXES.some((p) => name.startsWith(p));
}

/** Non-secret display hint: last 4 chars, only for values of 24+ chars (so 4 chars are a small part of the value) and when enabled. */
export function hintFor(plain: string, enabled = true): string {
  if (!enabled) return "";
  const chars = [...plain];
  return chars.length >= HINT_MIN_CHARS ? chars.slice(-4).join("") : "";
}
