import { hashToken, newRecoveryCodes, normalizeRecoveryCode } from "@/server/core/auth-crypto";
import { uuidv7 } from "@/server/core/ids";
import { generateSecret, otpauthUri, verifyTotp } from "@/server/core/totp";
import { VaultError, type Keyring } from "@/server/core/vault-crypto";
import { loadKeyring } from "@/server/db/master-key";
import { audit, lockOwner } from "@/server/db/owner";
import { atomic, type Db } from "@/server/db/stages";
import { getSecret, putSecret } from "@/server/db/vault";

// TOTP enrollment/verification and recovery codes. The TOTP secret lives only in the vault (secrets rows SECRET_NAME / PENDING_NAME);
// owner.totp_secret / totp_pending_secret hold a marker and owner.totp_encrypted = true. Any other non-null value is a pre-vault
// plaintext row: it is never used (fail closed) until scripts/totp-backfill.ts encrypts it. Never log a secret or put it in audit detail.
// Design note: the owner columns hold a marker and the ciphertext lives in separate `secrets` rows (not in the owner columns).
// Rolling a row back to an older ciphertext is a documented residual risk (vault-crypto.ts, no version in the AAD), and an attacker
// with app-role DML on these tables already has full compromise. A deleted `totp.secret` row does NOT turn 2FA off: totpEnabled
// keys off the owner marker, and the missing row makes every second factor fail closed.
// Recovery codes are stored only as SHA-256 hashes.
// Lock order follows owner.ts: owner advisory lock first, then the owner row (FOR UPDATE).

const ISSUER = "YT Studio";
export const SECRET_NAME = "totp.secret";
export const PENDING_NAME = "totp.pending";
export const SECRET_MARKER = `vault:${SECRET_NAME}`;
export const PENDING_MARKER = `vault:${PENDING_NAME}`;

/** TOTP cannot be checked because the vault is unusable or the row is not in vault form. Message is fixed: no key or secret material. */
export class TotpVaultError extends Error {
  constructor() {
    super("vault unavailable: two-factor verification is refused (check VAULT_MASTER_KEY and run db:migrate)");
    this.name = "TotpVaultError";
  }
}

let provider: () => Keyring = () => loadKeyring();
/** Test seam: inject a keyring source (null restores the environment-backed default). */
export function setTotpKeyring(p: (() => Keyring) | null): void {
  provider = p ?? (() => loadKeyring());
}
/** Resolves the keyring or throws TotpVaultError, whatever the cause (the cause text is dropped on purpose). */
export function totpKeyring(): Keyring {
  try {
    return provider();
  } catch {
    throw new TotpVaultError();
  }
}

type Row = { username: string; totp_secret: string | null; totp_pending_secret: string | null; totp_last_step: string | null; totp_encrypted: boolean };

async function lockedOwner(q: Db): Promise<Row | null> {
  await lockOwner(q);
  const { rows } = await q.query<Row>(
    "select username, totp_secret, totp_pending_secret, totp_last_step, totp_encrypted from owner where id = 1 for update",
  );
  return rows[0] ?? null;
}

/** The enabled secret in plaintext, only if the row is in vault form. Any failure is a TotpVaultError. */
async function readSecret(q: Db, o: Row, ring: Keyring): Promise<string> {
  if (!o.totp_encrypted || o.totp_secret !== SECRET_MARKER) throw new TotpVaultError();
  try {
    return await getSecret(q, ring, SECRET_NAME);
  } catch (e) {
    if (e instanceof VaultError) throw new TotpVaultError();
    throw e;
  }
}

const lastStep = (r: Row): number | null => (r.totp_last_step === null ? null : Number(r.totp_last_step));

async function storeCodes(q: Db): Promise<string[]> {
  const { codes, hashes } = newRecoveryCodes(10);
  await q.query("delete from recovery_codes");
  for (const h of hashes) await q.query("insert into recovery_codes (id, code_hash) values ($1, $2)", [uuidv7(), h]);
  return codes;
}

export async function totpEnabled(db: Db): Promise<boolean> {
  const { rows } = await db.query("select 1 from owner where id = 1 and totp_secret is not null");
  return rows.length > 0;
}

export async function unusedRecoveryCodeCount(db: Db): Promise<number> {
  const { rows } = await db.query<{ n: string }>("select count(*) as n from recovery_codes where used_at is null");
  return Number(rows[0]?.n ?? 0);
}

/** Starts (or restarts) enrollment. Nothing is enabled until enableTotp confirms a code. */
export async function beginTotpEnrollment(db: Db): Promise<{ secret: string; uri: string }> {
  return atomic(db, async (qc) => {
    const q = qc as Db;
    const o = await lockedOwner(q);
    if (!o) throw new Error("no owner");
    if (o.totp_secret !== null) throw new Error("totp already enabled");
    const ring = totpKeyring();
    const secret = generateSecret();
    await putSecret(q, ring, PENDING_NAME, secret, { hint: false });
    await q.query("update owner set totp_pending_secret = $1, updated_at = clock_timestamp() where id = 1", [PENDING_MARKER]);
    return { secret, uri: otpauthUri(secret, o.username, ISSUER) };
  });
}

/** Confirms the pending secret with a code. Returns the recovery codes in plaintext exactly once. */
export async function enableTotp(
  db: Db,
  code: string,
  nowMs: number = Date.now(),
): Promise<{ ok: true; recoveryCodes: string[] } | { ok: false }> {
  return atomic(db, async (qc) => {
    const q = qc as Db;
    const o = await lockedOwner(q);
    if (!o || o.totp_secret !== null || o.totp_pending_secret !== PENDING_MARKER) return { ok: false as const }; // legacy plaintext pending: restart enrollment
    const ring = totpKeyring();
    let pending: string;
    try {
      pending = await getSecret(q, ring, PENDING_NAME);
    } catch (e) {
      if (e instanceof VaultError) throw new TotpVaultError();
      throw e;
    }
    const v = verifyTotp(pending, code, nowMs, null);
    if (!v.ok) return { ok: false as const };
    await putSecret(q, ring, SECRET_NAME, pending, { hint: false });
    await q.query("delete from secrets where name = $1", [PENDING_NAME]);
    await q.query(
      "update owner set totp_secret = $2, totp_encrypted = true, totp_pending_secret = null, totp_last_step = $1, updated_at = clock_timestamp() where id = 1",
      [v.step, SECRET_MARKER],
    );
    const recoveryCodes = await storeCodes(q);
    await audit(q, "totp.enabled");
    return { ok: true as const, recoveryCodes };
  });
}

async function verifyLocked(q: Db, o: Row, code: string, nowMs: number): Promise<boolean> {
  if (o.totp_secret === null) return false;
  const secret = await readSecret(q, o, totpKeyring());
  const v = verifyTotp(secret, code, nowMs, lastStep(o));
  if (!v.ok) return false;
  const r = await q.query(
    "update owner set totp_last_step = $1 where id = 1 and (totp_last_step is null or totp_last_step < $1)",
    [v.step],
  );
  return (r.rowCount ?? 0) === 1;
}

/** Verifies a login TOTP code and burns its step. Throws TotpVaultError (fail closed) when the vault cannot open the secret. Concurrent use of one code: exactly one caller gets true. */
export async function verifyOwnerTotp(db: Db, code: string, nowMs: number = Date.now()): Promise<boolean> {
  return atomic(db, async (qc) => {
    const q = qc as Db;
    const o = await lockedOwner(q);
    return o ? verifyLocked(q, o, code, nowMs) : false;
  });
}

/** Single-use. Bad format returns false without touching the database. */
export async function useRecoveryCode(db: Db, code: string): Promise<boolean> {
  const n = normalizeRecoveryCode(code);
  if (n === null) return false;
  const r = await db.query(
    "update recovery_codes set used_at = clock_timestamp() where code_hash = $1 and used_at is null returning id",
    [hashToken(n)],
  );
  return r.rows.length === 1;
}

/** Requires a current TOTP code or an unused recovery code. Clears all TOTP state and recovery codes. */
export async function disableTotp(db: Db, opts: { proof: string; nowMs?: number }): Promise<boolean> {
  return atomic(db, async (qc) => {
    const q = qc as Db;
    const o = await lockedOwner(q);
    if (!o || o.totp_secret === null) return false;
    const ok = (await verifyLocked(q, o, opts.proof, opts.nowMs ?? Date.now())) || (await useRecoveryCode(q, opts.proof));
    if (!ok) return false;
    await q.query(
      "update owner set totp_secret = null, totp_pending_secret = null, totp_encrypted = false, totp_last_step = null, updated_at = clock_timestamp() where id = 1",
    );
    await q.query("delete from secrets where name in ($1, $2)", [SECRET_NAME, PENDING_NAME]);
    await q.query("delete from recovery_codes");
    await audit(q, "totp.disabled");
    return true;
  });
}

/** Replaces every recovery code (used or not). TOTP must be enabled. */
export async function regenerateRecoveryCodes(db: Db): Promise<string[]> {
  return atomic(db, async (qc) => {
    const q = qc as Db;
    const o = await lockedOwner(q);
    if (!o || o.totp_secret === null) throw new Error("totp not enabled");
    const codes = await storeCodes(q);
    await audit(q, "totp.recovery_regenerated");
    return codes;
  });
}
