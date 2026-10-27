import { randomBytes } from "node:crypto";
import type pg from "pg";
import { decryptSecret, encryptSecret, VaultError, type Keyring } from "@/server/core/vault-crypto";
import { loadKeyring } from "@/server/db/master-key";

// The HMAC key for signed media URLs: a vault secret, created on first use. Stored base64 (32 random bytes). Rotating
// the vault master key re-wraps it (same value), rotating THIS value (deleting the row) invalidates every URL, which is
// acceptable. Plaintext lives only in the returned Buffer; nothing is cached, logged or put in an error message.

type Db = Pick<pg.Pool, "query">;
export const MEDIA_KEY_SECRET = "media.signing";
const KEY_BYTES = 32;

export class MediaKeyError extends Error {
  constructor(readonly code: "vault_unreadable" | "key_corrupt") {
    super(code === "vault_unreadable" ? "The media signing key cannot be read with the loaded vault key" : "The stored media signing key is malformed");
    this.name = "MediaKeyError";
  }
}

interface Row {
  ciphertext: Buffer;
  nonce: Buffer;
  key_id: string;
}

function parse(plain: string): Buffer {
  const key = Buffer.from(plain, "base64");
  if (key.length !== KEY_BYTES || key.toString("base64") !== plain) throw new MediaKeyError("key_corrupt");
  return key;
}

async function read(db: Db, ring: Keyring): Promise<Buffer | null> {
  const { rows } = await db.query<Row>("select ciphertext, nonce, key_id from secrets where name = $1", [MEDIA_KEY_SECRET]);
  const r = rows[0];
  if (!r) return null;
  let plain: string;
  try {
    plain = decryptSecret(ring, MEDIA_KEY_SECRET, { ciphertext: r.ciphertext, nonce: r.nonce, keyId: r.key_id });
  } catch (e) {
    if (e instanceof VaultError) throw new MediaKeyError("vault_unreadable");
    throw e;
  }
  return parse(plain);
}

function ringOrThrow(ring: Keyring | undefined): Keyring {
  if (ring) return ring;
  try {
    return loadKeyring();
  } catch (e) {
    if (e instanceof VaultError) throw new MediaKeyError("vault_unreadable");
    throw e;
  }
}

/** Read-only: null when no key has been created yet (so no URL can be valid). Throws MediaKeyError when it cannot be read. */
export async function getMediaKey(db: Db, ring?: Keyring): Promise<Buffer | null> {
  return read(db, ringOrThrow(ring));
}

/**
 * Returns the key, creating it if absent. Safe under concurrency (insert ... on conflict do nothing, then read back, so
 * every caller ends up with the winner's value). An existing key that cannot be decrypted is an ERROR: it is never
 * replaced, because replacing it would silently invalidate every URL and hide a wrong or missing vault key.
 */
export async function getOrCreateMediaKey(db: Db, ring?: Keyring): Promise<Buffer> {
  const r = ringOrThrow(ring);
  const existing = await read(db, r);
  if (existing) return existing;
  const sealed = encryptSecret(r, MEDIA_KEY_SECRET, randomBytes(KEY_BYTES).toString("base64"));
  await db.query(
    "insert into secrets (name, ciphertext, nonce, key_id, hint) values ($1, $2, $3, $4, '') on conflict (name) do nothing",
    [MEDIA_KEY_SECRET, sealed.ciphertext, sealed.nonce, sealed.keyId],
  );
  const winner = await read(db, r);
  if (!winner) throw new MediaKeyError("vault_unreadable"); // row vanished between insert and read (deleted concurrently)
  return winner;
}

// Short-lived copy for the media route, which would otherwise read and decrypt on every Range request. This is the one
// deliberate exception to "decrypt per call": 30 s for a found key (deleting the secret still kills every URL within that
// window), 5 s for "no key yet" so a key created by another process is picked up quickly. Errors are never cached.
// clearMediaKeyCache() wipes it (tests, rotation tooling).
const HIT_TTL_MS = 30_000;
const MISS_TTL_MS = 5_000;
let cache: { key: Buffer | null; until: number } | undefined;

export function clearMediaKeyCache(): void {
  cache = undefined;
}

export async function getCachedMediaKey(db: Db, ring?: Keyring, now: () => number = Date.now): Promise<Buffer | null> {
  const t = now();
  if (cache && t < cache.until) return cache.key;
  const key = await getMediaKey(db, ring);
  cache = { key, until: t + (key ? HIT_TTL_MS : MISS_TTL_MS) };
  return key;
}
