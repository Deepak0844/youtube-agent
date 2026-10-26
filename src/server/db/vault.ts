// DB side of the secrets vault. Crypto is in core/vault-crypto.ts; the keyring is injected (see master-key.ts).
// Plaintext exists only in the return value of getSecret and in the argument of putSecret: it is decrypted per call,
// never cached, never logged, and list/status paths never decrypt for display (they expose the stored masked tail only).
import type pg from "pg";
import { decryptSecret, encryptSecret, hintFor, VaultError, type Keyring } from "@/server/core/vault-crypto";

type Db = Pick<pg.Pool, "query">;
interface Row {
  name: string;
  ciphertext: Buffer;
  nonce: Buffer;
  key_id: string;
}

export interface SecretListing {
  name: string;
  hint: string;
  keyId: string;
  updatedAt: Date;
}
export type VaultStatus = { status: "ok" | "wrong_key" | "unreadable"; unreadable: string[] };

export async function putSecret(db: Db, ring: Keyring, name: string, plain: string): Promise<void> {
  const s = encryptSecret(ring, name, plain); // validates name and size before any DB write
  await db.query(
    `insert into secrets (name, ciphertext, nonce, key_id, hint) values ($1, $2, $3, $4, $5)
     on conflict (name) do update set ciphertext = excluded.ciphertext, nonce = excluded.nonce, key_id = excluded.key_id,
       hint = excluded.hint, updated_at = now()`,
    [name, s.ciphertext, s.nonce, s.keyId, hintFor(plain)],
  );
}

/** Decrypts on every call. Throws VaultError (not_found | wrong_key | decrypt_failed); never returns "" on failure. */
export async function getSecret(db: Db, ring: Keyring, name: string): Promise<string> {
  const { rows } = await db.query<Row>("select name, ciphertext, nonce, key_id from secrets where name = $1", [name]);
  const r = rows[0];
  if (!r) throw new VaultError("not_found");
  return decryptSecret(ring, r.name, { ciphertext: r.ciphertext, nonce: r.nonce, keyId: r.key_id });
}

export async function hasSecret(db: Db, name: string): Promise<boolean> {
  const { rows } = await db.query("select 1 from secrets where name = $1", [name]);
  return rows.length > 0;
}

export async function deleteSecret(db: Db, name: string): Promise<boolean> {
  const r = await db.query("delete from secrets where name = $1", [name]);
  return (r.rowCount ?? 0) > 0;
}

/** For UI: name, masked tail and metadata only. Selects no ciphertext and needs no key. */
export async function listSecrets(db: Db): Promise<SecretListing[]> {
  const { rows } = await db.query<{ name: string; hint: string; key_id: string; updated_at: Date }>(
    "select name, hint, key_id, updated_at from secrets order by name",
  );
  return rows.map((r) => ({ name: r.name, hint: r.hint, keyId: r.key_id, updatedAt: r.updated_at }));
}

/** Decrypts every row to prove the loaded key opens them (nothing is returned or logged but names). */
export async function vaultStatus(db: Db, ring: Keyring): Promise<VaultStatus> {
  const { rows } = await db.query<Row>("select name, ciphertext, nonce, key_id from secrets order by name");
  const unreadable: string[] = [];
  let wrongKey = false;
  for (const r of rows) {
    try {
      decryptSecret(ring, r.name, { ciphertext: r.ciphertext, nonce: r.nonce, keyId: r.key_id });
    } catch (e) {
      unreadable.push(r.name);
      if (e instanceof VaultError && e.code === "wrong_key") wrongKey = true;
    }
  }
  return { status: unreadable.length === 0 ? "ok" : wrongKey ? "wrong_key" : "unreadable", unreadable };
}

/** Rotation: re-encrypts every row not sealed by the current key. Returns the number rewrapped; idempotent. Fails (throws) on the first unreadable row. */
export async function rewrapAll(db: Db, ring: Keyring): Promise<number> {
  const { rows } = await db.query<Row>("select name, ciphertext, nonce, key_id from secrets where key_id <> $1 order by name", [ring.current.id]);
  let n = 0;
  for (const r of rows) {
    const plain = decryptSecret(ring, r.name, { ciphertext: r.ciphertext, nonce: r.nonce, keyId: r.key_id });
    const s = encryptSecret(ring, r.name, plain);
    // Guarded on the old nonce so a concurrent put() of a newer value is not overwritten with the stale one.
    const u = await db.query("update secrets set ciphertext = $2, nonce = $3, key_id = $4 where name = $1 and nonce = $5", [
      r.name,
      s.ciphertext,
      s.nonce,
      s.keyId,
      r.nonce,
    ]);
    n += u.rowCount ?? 0;
  }
  return n;
}
