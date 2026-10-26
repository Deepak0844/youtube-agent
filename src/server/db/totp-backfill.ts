import type { Keyring } from "@/server/core/vault-crypto";
import { audit, lockOwner } from "@/server/db/owner";
import { atomic, type Db } from "@/server/db/stages";
import { PENDING_MARKER, PENDING_NAME, SECRET_MARKER, SECRET_NAME } from "@/server/db/totp";
import { getSecret, putSecret } from "@/server/db/vault";

// Encrypts pre-vault plaintext TOTP secrets (migration 0008 cannot: it has no master key). Idempotent: rows already in vault form
// are never touched, so a run with the wrong key cannot damage them. Each value is read back through the vault before the plaintext
// column is overwritten, all in one transaction under the owner lock.

type Row = { totp_secret: string | null; totp_pending_secret: string | null };
const isPlain = (v: string | null): v is string => v !== null && !v.startsWith("vault:");

async function seal(q: Db, ring: Keyring, name: string, plain: string): Promise<void> {
  await putSecret(q, ring, name, plain, { hint: false });
  if ((await getSecret(q, ring, name)) !== plain) throw new Error("totp backfill: read-back mismatch");
}

export async function hasPlaintextTotp(db: Db): Promise<boolean> {
  const { rows } = await db.query<Row>("select totp_secret, totp_pending_secret from owner where id = 1");
  const r = rows[0];
  return !!r && (isPlain(r.totp_secret) || isPlain(r.totp_pending_secret));
}

/** CLI/migrate wrapper: needs the key only when a plaintext row exists. Output carries counts only, never secrets or key text. */
export async function runTotpBackfill(db: Db, loadRing: () => Keyring): Promise<{ exitCode: number; message: string }> {
  if (!(await hasPlaintextTotp(db))) return { exitCode: 0, message: "totp backfill: nothing to do\n" };
  let ring: Keyring;
  try {
    ring = loadRing();
  } catch {
    return {
      exitCode: 1,
      message:
        "totp backfill: plaintext TOTP secret found but VAULT_MASTER_KEY is missing or malformed. Two-factor login stays refused until you fix .env.local and run `npm run totp:backfill`.\n",
    };
  }
  const r = await backfillTotpSecrets(db, ring);
  return { exitCode: 0, message: `totp backfill: encrypted secret=${r.secret} pending=${r.pending}\n` };
}

export async function backfillTotpSecrets(db: Db, ring: Keyring): Promise<{ secret: boolean; pending: boolean }> {
  return atomic(db, async (qc) => {
    const q = qc as Db;
    await lockOwner(q);
    const { rows } = await q.query<Row>("select totp_secret, totp_pending_secret from owner where id = 1 for update");
    const r = rows[0];
    const out = { secret: false, pending: false };
    if (!r) return out;
    if (isPlain(r.totp_secret)) {
      await seal(q, ring, SECRET_NAME, r.totp_secret);
      await q.query("update owner set totp_secret = $1, totp_encrypted = true where id = 1", [SECRET_MARKER]);
      out.secret = true;
    }
    if (isPlain(r.totp_pending_secret)) {
      await seal(q, ring, PENDING_NAME, r.totp_pending_secret);
      await q.query("update owner set totp_pending_secret = $1 where id = 1", [PENDING_MARKER]);
      out.pending = true;
    }
    if (out.secret || out.pending) await audit(q, "totp.backfilled", { rows: Number(out.secret) + Number(out.pending) });
    return out;
  });
}
