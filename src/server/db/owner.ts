import { hashPassword, hashToken, newToken } from "@/server/core/auth-crypto";
import { normalizeUsername, validatePassword } from "@/server/core/auth-rules";
import { uuidv7 } from "@/server/core/ids";
import { insertAudit } from "@/server/db/audit";
import { atomic, type Db } from "@/server/db/stages";

// Owner setup links and owner-level operations. Only SHA-256 hashes of tokens are stored. Every expiry/used comparison
// uses the DATABASE clock (clock_timestamp()). Never put tokens, passwords, codes or links in audit detail.
//
// LOCK ORDER (every writer, to avoid deadlocks): 0) auth.ts login/changePassword only: advisory locks login:<username_key>
// then loginip:<ip> (kept as defence in depth; the owner lock below already serialises them), 1) the owner advisory lock
// (lockOwner), 2) the per-purpose setup_links advisory lock (createSetupLink only), 3) row locks: owner row, then
// setup_links rows. Never take them in another order.

export type SetupPurpose = "create" | "reset";
export type ConsumeResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "expired" | "used" | "weak_password" | "bad_username" };

const LINK_TTL = "24 hours";

export async function ownerExists(db: Db): Promise<boolean> {
  const { rows } = await db.query("select 1 from owner where id = 1");
  return rows.length > 0;
}

export async function revokeAllSessions(db: Db): Promise<number> {
  const r = await db.query("update sessions set revoked_at = clock_timestamp() where revoked_at is null");
  return r.rowCount ?? 0;
}

// Thin legacy wrapper over the shared writer (src/server/db/audit.ts). Outside production a secret-looking value is a bug in
// the caller and fails loudly; in production it is redacted and we carry on.
export async function audit(db: Db, event: string, detail: Record<string, unknown> = {}): Promise<void> {
  await insertAudit(db, event, detail, { failOnSecret: true });
}

// Owner-level lock, first in the lock order. Transaction-scoped; works with no owner row and re-entrant in one session.
export async function lockOwner(db: Db): Promise<void> {
  await db.query("select pg_advisory_xact_lock(hashtext('owner_auth'))");
}

// Clears TOTP + recovery codes and revokes every session. Caller supplies the transaction.
export async function clearOwnerSecurity(db: Db): Promise<{ sessionsRevoked: number }> {
  await db.query("update owner set totp_secret = null, totp_pending_secret = null, totp_encrypted = false, totp_last_step = null, updated_at = clock_timestamp() where id = 1");
  await db.query("delete from secrets where name in ('totp.secret', 'totp.pending')");
  await db.query("delete from recovery_codes");
  return { sessionsRevoked: await revokeAllSessions(db) };
}

export async function createSetupLink(db: Db, purpose: SetupPurpose, baseUrl: string): Promise<string> {
  if (purpose !== "create" && purpose !== "reset") throw new RangeError("invalid purpose");
  const { token, tokenHash } = newToken();
  await atomic(db, async (qc) => {
    const q = qc as Db;
    await lockOwner(q);
    await q.query("select pg_advisory_xact_lock(hashtext('setup_links:' || $1::text))", [purpose]);
    // A newer link replaces every older unused link of the same purpose (expired-unused ones included, so the unique index never blocks).
    await q.query("update setup_links set used_at = clock_timestamp() where purpose = $1 and used_at is null", [purpose]);
    await q.query(
      `insert into setup_links (id, token_hash, purpose, expires_at) values ($1, $2, $3, clock_timestamp() + interval '${LINK_TTL}')`,
      [uuidv7(), tokenHash, purpose],
    );
  });
  return `${baseUrl.replace(/\/+$/, "")}/setup/${token}`;
}

type LinkState = { id: string; purpose: SetupPurpose; used: boolean; expired: boolean };

async function readLink(q: Db, tokenHash: string, lock: boolean): Promise<LinkState | null> {
  const { rows } = await q.query<LinkState>(
    `select id, purpose, used_at is not null as used, expires_at <= clock_timestamp() as expired
       from setup_links where token_hash = $1${lock ? " for update" : ""}`,
    [tokenHash],
  );
  return rows[0] ?? null;
}

/** Read-only: is this setup link usable right now? One neutral boolean, so the page cannot reveal why a link is bad. */
export async function setupLinkUsable(db: Db, token: string): Promise<boolean> {
  try {
    return refusal(await readLink(db, hashToken(token), false)) === null;
  } catch {
    return false;
  }
}

const refusal = (l: LinkState | null): ConsumeResult | null =>
  !l ? { ok: false, reason: "invalid" } : l.used ? { ok: false, reason: "used" } : l.expired ? { ok: false, reason: "expired" } : null;

export async function consumeSetupLink(
  db: Db,
  token: string,
  input: { username: string; password: string },
): Promise<ConsumeResult> {
  let tokenHash: string;
  try {
    tokenHash = hashToken(token);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  // Cheap unlocked pre-check: a bad/used/expired token never costs a 170 ms scrypt, and no row lock is held while hashing.
  const pre = refusal(await readLink(db, tokenHash, false));
  if (pre) return pre;

  // Validate BEFORE consuming: a weak password or bad username must leave the link usable.
  const username = normalizeUsername(input?.username);
  if (username === null) return { ok: false, reason: "bad_username" };
  const pw = typeof input.password === "string" ? input.password : "";
  if (!validatePassword(pw, username).ok) return { ok: false, reason: "weak_password" };
  let passwordHash: string;
  try {
    passwordHash = await hashPassword(pw);
  } catch {
    return { ok: false, reason: "weak_password" }; // e.g. over the length cap
  }

  // Lock, re-verify and write in one transaction; the row lock makes concurrent consumers take turns.
  return atomic(db, async (qc): Promise<ConsumeResult> => {
    const q = qc as Db;
    await lockOwner(q);
    await q.query("select 1 from owner where id = 1 for update");
    const link = await readLink(q, tokenHash, true);
    const bad = refusal(link);
    if (bad || !link) return bad ?? { ok: false, reason: "invalid" };

    if (link.purpose === "create") {
      const ins = await q.query(
        `insert into owner (id, username, password_hash) values (1, $1, $2) on conflict (id) do nothing returning id`,
        [username, passwordHash],
      );
      if (ins.rows.length === 0) return { ok: false, reason: "invalid" }; // an owner already exists
    } else {
      const upd = await q.query(
        "update owner set username = $1, password_hash = $2, updated_at = clock_timestamp() where id = 1 returning id",
        [username, passwordHash],
      );
      if (upd.rows.length === 0) return { ok: false, reason: "invalid" };
      await clearOwnerSecurity(q);
    }
    await q.query("update setup_links set used_at = clock_timestamp() where id = $1", [link.id]);
    await audit(q, link.purpose === "create" ? "owner.created" : "owner.reset_completed", { purpose: link.purpose });
    return { ok: true };
  });
}
