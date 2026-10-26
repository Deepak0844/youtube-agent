import { hashToken, newRecoveryCodes, normalizeRecoveryCode } from "@/server/core/auth-crypto";
import { uuidv7 } from "@/server/core/ids";
import { generateSecret, otpauthUri, verifyTotp } from "@/server/core/totp";
import { audit, lockOwner } from "@/server/db/owner";
import { atomic, type Db } from "@/server/db/stages";

// TOTP enrollment/verification and recovery codes. The TOTP secret is stored RAW in owner.totp_secret / totp_pending_secret
// until the Phase 1 vault exists; never log it or put it in audit detail. Recovery codes are stored only as SHA-256 hashes.
// Lock order follows owner.ts: owner advisory lock first, then the owner row (FOR UPDATE).

const ISSUER = "YT Studio";
type Row = { username: string; totp_secret: string | null; totp_pending_secret: string | null; totp_last_step: string | null };

async function lockedOwner(q: Db): Promise<Row | null> {
  await lockOwner(q);
  const { rows } = await q.query<Row>(
    "select username, totp_secret, totp_pending_secret, totp_last_step from owner where id = 1 for update",
  );
  return rows[0] ?? null;
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
    const secret = generateSecret();
    await q.query("update owner set totp_pending_secret = $1, updated_at = clock_timestamp() where id = 1", [secret]);
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
    if (!o || o.totp_secret !== null || o.totp_pending_secret === null) return { ok: false as const };
    const v = verifyTotp(o.totp_pending_secret, code, nowMs, null);
    if (!v.ok) return { ok: false as const };
    await q.query(
      "update owner set totp_secret = totp_pending_secret, totp_pending_secret = null, totp_last_step = $1, updated_at = clock_timestamp() where id = 1",
      [v.step],
    );
    const recoveryCodes = await storeCodes(q);
    await audit(q, "totp.enabled");
    return { ok: true as const, recoveryCodes };
  });
}

async function verifyLocked(q: Db, o: Row, code: string, nowMs: number): Promise<boolean> {
  if (o.totp_secret === null) return false;
  const v = verifyTotp(o.totp_secret, code, nowMs, lastStep(o));
  if (!v.ok) return false;
  const r = await q.query(
    "update owner set totp_last_step = $1 where id = 1 and (totp_last_step is null or totp_last_step < $1)",
    [v.step],
  );
  return (r.rowCount ?? 0) === 1;
}

/** Verifies a login TOTP code and burns its step. Concurrent use of one code: exactly one caller gets true. */
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
      "update owner set totp_secret = null, totp_pending_secret = null, totp_last_step = null, updated_at = clock_timestamp() where id = 1",
    );
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
