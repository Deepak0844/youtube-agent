import { createHash } from "node:crypto";
import { dummyVerify, hashPassword, hashToken, needsRehash, newToken, verifyPassword } from "@/server/core/auth-crypto";
import { lockoutDelayMs, normalizeUsername, sessionExpiry, validatePassword } from "@/server/core/auth-rules";
import { uuidv7 } from "@/server/core/ids";
import { createAdmission, type Admission } from "@/server/core/admission";
import { normalizeIp, UNKNOWN_IP } from "@/server/core/ip";
import { createSemaphore } from "@/server/core/semaphore";
import { audit, lockOwner } from "@/server/db/owner";
import { atomic, type Db } from "@/server/db/stages";
import { totpEnabled, useRecoveryCode, verifyOwnerTotp } from "@/server/db/totp";

// Login, sessions and lockout. Only SHA-256 of session tokens is stored. Lockout and expiry use the DATABASE clock.
//
// DESIGN (documented decisions)
// - ADMISSION (before any DB use): at most `maxInFlightAuth` (default 3) login/changePassword attempts in flight or queued
//   process-wide, and 1 per ip. Excess attempts return `busy` immediately and never check out a connection, so a flood of
//   unauthenticated requests cannot starve the pool. `configureAuthAdmission` changes the limits.
// - LOCK ORDER (login and changePassword): advisory lock login:<username_key>, then loginip:<ip>, then the owner advisory
//   lock (owner.ts), then the owner row, then other rows. All are held for the whole attempt, scrypt included, so attempts
//   are strictly serial and a burst of N wrong passwords gets exactly 5 real verifies (overshoot 0). The owner lock alone
//   already serialises everything; the per-key locks are kept as defence in depth in case that lock is ever narrowed.
// - Concurrent scrypt is capped by a process-wide semaphore of 2 (each hash needs ~128 MiB).
// - LOCK RULE: failures since the last success for the key within 24 h; delay = lockoutDelayMs(count) (cap 1 h); locked
//   while clock_timestamp() < last REAL failure + delay. Attempts made while locked are refused with `locked`, are NOT
//   verified, NOT recorded and NOT audited, so they never extend the lock: an attacker cannot keep a key locked beyond
//   `delay` after the last verified failure by hammering it.
// - KNOWN-GOOD IP: the USERNAME lock does not apply to an ip with a successful login row for that username in the last 30
//   days, so the owner is not locked out from their usual address by an attacker's failures. The IP lock still applies to
//   everyone, and a known-good ip's real failures count normally (toward both keys). The 'unknown' ip is never known-good.
//   Ips are normalised (normalizeIp: trim, lowercase, zone id stripped, IPv4-mapped IPv6 -> IPv4) before every key use.
// - RESIDUAL LIMITS (accepted for the spike): (1) a flood from many unknown ips can keep the username locked for NEW ips for up
//   to 1 h per real failure; the owner on a known-good ip is unaffected; remedies are owner:reset or waiting. (2) three attacker
//   ips can hold every admission slot and make the owner's login return `busy`. A reserved slot for known-good ips and proxy
//   rate limiting must be done before the server move (Phase 10).
// - Full success writes one success row (username_key + ip): it ends the failure streak of both keys.
// - needs_totp (password right, TOTP on, no code): nothing recorded, no reset, no session. Wrong second factor = failure.
// - Invalid username strings: keyed by a hash of the raw input, dummyVerify path, same result as an unknown user.
// - Audit rows carry only event + reason (+ ip); never usernames, passwords, tokens or codes.

// Admission and the scrypt semaphore live on globalThis: Next bundles this module once per entry (route handler, server
// action, page), and per-bundle copies would each grant the full cap. Created lazily, shared by every copy.
const SHARED = Symbol.for("ytstudio.auth.shared");
interface Shared {
  admission: Admission;
  semaphore: ReturnType<typeof createSemaphore>;
}
function shared(): Shared {
  const g = globalThis as unknown as Record<symbol, Shared | undefined>;
  return (g[SHARED] ??= { admission: createAdmission({ maxTotal: 3, maxPerKey: 1 }), semaphore: createSemaphore(2) });
}
export const passwordSemaphore = { run: <T>(fn: () => Promise<T>): Promise<T> => shared().semaphore.run(fn) };

/** Startup/test hook: replaces the shared admission limits (resets the in-flight counters). */
export function configureAuthAdmission(o: { maxInFlightAuth?: number; maxPerIp?: number } = {}): void {
  shared().admission = createAdmission({ maxTotal: o.maxInFlightAuth ?? 3, maxPerKey: o.maxPerIp ?? 1 });
}
export const authInFlight = (): number => shared().admission.inFlight();

export const IDLE_MS = 8 * 3_600_000;
const MAX_PW_UNITS = 1024;
const UA_MAX = 255;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type LoginResult =
  | { ok: true; token: string; expiresAt: Date; absoluteExpiresAt: Date }
  | { ok: false; reason: "invalid" | "locked" | "needs_totp" | "busy"; retryAfterMs?: number };

export interface LoginInput {
  username: string;
  password: string;
  code?: string;
  ip?: string;
  userAgent?: string;
  now?: Date;
}

const sha16 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
const cleanIp = normalizeIp;

async function lockKeys(q: Db, key: string, ip: string): Promise<void> {
  await q.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`login:${key}`]);
  await q.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`loginip:${ip}`]);
}

type KeyCol = "username_key" | "ip";
// Milliseconds the key is still locked (0 = free), measured on the DB clock.
async function lockedFor(q: Db, col: KeyCol, val: string): Promise<number> {
  const { rows } = await q.query<{ n: string; age_ms: number | null }>(
    `select count(*) as n, extract(epoch from (clock_timestamp() - max(at))) * 1000 as age_ms
       from login_attempts
      where ${col} = $1 and not success
        and at > clock_timestamp() - interval '24 hours'
        and at > coalesce((select max(at) from login_attempts where ${col} = $1 and success), '-infinity'::timestamptz)`,
    [val],
  );
  const r = rows[0];
  const delay = lockoutDelayMs(Number(r?.n ?? 0));
  if (delay === 0 || r?.age_ms == null) return 0;
  return Math.max(0, Math.ceil(delay - r.age_ms));
}

const record = (q: Db, key: string, ip: string, success: boolean) =>
  q.query("insert into login_attempts (username_key, ip, at, success) values ($1, $2, clock_timestamp(), $3)", [key, ip, success]);

async function knownGoodIp(q: Db, key: string, ip: string): Promise<boolean> {
  if (ip === UNKNOWN_IP) return false; // a caller without an ip can never bypass the username lock
  const { rows } = await q.query(
    "select 1 from login_attempts where username_key = $1 and ip = $2 and success and at > clock_timestamp() - interval '30 days' limit 1",
    [key, ip],
  );
  return rows.length > 0;
}

// Ip lock applies to everyone; the username lock does not apply to a known-good ip.
async function checkLocks(q: Db, key: string, ip: string): Promise<number> {
  const ipWait = await lockedFor(q, "ip", ip);
  const userWait = (await knownGoodIp(q, key, ip)) ? 0 : await lockedFor(q, "username_key", key);
  return Math.max(ipWait, userWait);
}

export async function login(db: Db, input: LoginInput): Promise<LoginResult> {
  const release = shared().admission.tryEnter(cleanIp(input?.ip));
  if (!release) return { ok: false, reason: "busy" };
  try {
    return await loginAdmitted(db, input);
  } finally {
    release();
  }
}

async function loginAdmitted(db: Db, input: LoginInput): Promise<LoginResult> {
  const ip = cleanIp(input.ip);
  const norm = normalizeUsername(input.username);
  const key = norm ?? `~invalid:${sha16(String(input.username))}`; // '~' cannot occur in a valid username
  const pwOk = typeof input.password === "string" && input.password.length <= MAX_PW_UNITS;
  const nowMs = (input.now ?? new Date()).getTime();
  const ua = typeof input.userAgent === "string" ? input.userAgent.slice(0, UA_MAX) : null;

  const out = await atomic(db, async (qc): Promise<{ result: LoginResult; rehash?: { old: string; pw: string } }> => {
    const q = qc as Db;
    await lockKeys(q, key, ip);
    await lockOwner(q); // before reading the owner: a concurrent reset must finish first (or wait for us), never be bypassed

    const wait = await checkLocks(q, key, ip);
    if (wait > 0) return { result: { ok: false, reason: "locked", retryAfterMs: wait } }; // nothing recorded: never extends the lock

    const { rows } = await q.query<{ username: string; password_hash: string }>("select username, password_hash from owner where id = 1");
    const owner = rows[0];
    let good = false;
    if (owner && norm !== null && pwOk && owner.username === norm) {
      good = await passwordSemaphore.run(() => verifyPassword(input.password, owner.password_hash));
    } else {
      await passwordSemaphore.run(() => dummyVerify());
    }
    const fail = async (): Promise<{ result: LoginResult }> => {
      await record(q, key, ip, false);
      await audit(q, "login.failure", { reason: "invalid", ip });
      return { result: { ok: false, reason: "invalid" } };
    };
    if (!good || !owner) return fail();

    if (await totpEnabled(q)) {
      const code = input.code;
      if (code === undefined || code === "") return { result: { ok: false, reason: "needs_totp" } };
      const second = typeof code === "string" && ((await verifyOwnerTotp(q, code, nowMs)) || (await useRecoveryCode(q, code)));
      if (!second) return fail();
    }

    await record(q, key, ip, true);
    const { token, tokenHash } = newToken();
    const s = await q.query<{ expires_at: Date; absolute_expires_at: Date }>(
      `insert into sessions (id, token_hash, created_at, last_seen_at, expires_at, absolute_expires_at, user_agent, ip)
       values ($1, $2, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '8 hours', clock_timestamp() + interval '7 days', $3, $4)
       returning expires_at, absolute_expires_at`,
      [uuidv7(), tokenHash, ua, ip],
    );
    await audit(q, "login.success", { ip });
    const row = s.rows[0]!;
    return {
      result: { ok: true, token, expiresAt: row.expires_at, absoluteExpiresAt: row.absolute_expires_at },
      rehash: needsRehash(owner.password_hash) ? { old: owner.password_hash, pw: input.password } : undefined,
    };
  });

  if (out.rehash) {
    // After commit, off the critical path; a failure never fails the login. Compare-and-set so a concurrent change wins.
    try {
      const h = await passwordSemaphore.run(() => hashPassword(out.rehash!.pw));
      await db.query("update owner set password_hash = $1, updated_at = clock_timestamp() where id = 1 and password_hash = $2", [h, out.rehash.old]);
    } catch {
      /* ignore */
    }
  }
  if (out.result.ok) maybePurge(db);
  return out.result;
}

export async function validateSession(db: Db, token: string, opts: { now?: Date } = {}): Promise<{ ok: true; sessionId: string } | { ok: false }> {
  try {
    if (typeof token !== "string") return { ok: false };
    const th = hashToken(token); // throws on empty / > 256
    const { rows } = await db.query<{ id: string; created_at: Date; last_seen_at: Date; revoked: boolean; db_now: Date }>(
      "select id, created_at, last_seen_at, revoked_at is not null as revoked, clock_timestamp() as db_now from sessions where token_hash = $1",
      [th],
    );
    const s = rows[0];
    if (!s || s.revoked) return { ok: false };
    const now = opts.now ?? s.db_now;
    const e = sessionExpiry(now, s.created_at, s.last_seen_at);
    if (e.idleExpired || e.absoluteExpired) return { ok: false };
    await db.query(
      `update sessions set last_seen_at = clock_timestamp(), expires_at = clock_timestamp() + interval '8 hours'
        where id = $1 and revoked_at is null and last_seen_at < clock_timestamp() - interval '60 seconds'`,
      [s.id],
    );
    return { ok: true, sessionId: s.id };
  } catch {
    return { ok: false };
  }
}

export async function logout(db: Db, token: string): Promise<void> {
  let th: string;
  try {
    th = hashToken(token);
  } catch {
    return;
  }
  await db.query("update sessions set revoked_at = clock_timestamp() where token_hash = $1 and revoked_at is null", [th]);
}

export interface SessionInfo {
  id: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  absoluteExpiresAt: Date;
  userAgent: string | null;
  ip: string | null;
}

// Live sessions only (not revoked, not expired). Never returns token material.
export async function listSessions(db: Db): Promise<SessionInfo[]> {
  const { rows } = await db.query(
    `select id, created_at, last_seen_at, expires_at, absolute_expires_at, user_agent, ip from sessions
      where revoked_at is null and absolute_expires_at > clock_timestamp() and last_seen_at > clock_timestamp() - interval '8 hours'
      order by created_at desc`,
  );
  return rows.map((r) => ({
    id: r.id, createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at,
    absoluteExpiresAt: r.absolute_expires_at, userAgent: r.user_agent, ip: r.ip,
  }));
}

export async function revokeSession(db: Db, sessionId: string): Promise<boolean> {
  if (typeof sessionId !== "string" || !UUID_RE.test(sessionId)) return false;
  const r = await db.query("update sessions set revoked_at = clock_timestamp() where id = $1 and revoked_at is null", [sessionId]);
  return (r.rowCount ?? 0) === 1;
}

export async function revokeOtherSessions(db: Db, keepSessionId: string): Promise<number> {
  if (typeof keepSessionId !== "string" || !UUID_RE.test(keepSessionId)) return 0;
  const r = await db.query("update sessions set revoked_at = clock_timestamp() where id <> $1 and revoked_at is null", [keepSessionId]);
  return r.rowCount ?? 0;
}

export type ChangePasswordResult = { ok: true; token: string } | { ok: false; reason: "invalid" | "weak_password" | "locked" | "busy" };

export async function changePassword(db: Db, sessionId: string, current: string, next: string, ip?: string): Promise<ChangePasswordResult> {
  const clean = cleanIp(ip);
  const release = shared().admission.tryEnter(clean);
  if (!release) return { ok: false, reason: "busy" };
  try {
    return await changePasswordAdmitted(db, sessionId, current, next, clean);
  } finally {
    release();
  }
}

async function changePasswordAdmitted(db: Db, sessionId: string, current: string, next: string, ip: string): Promise<ChangePasswordResult> {
  if (typeof sessionId !== "string" || !UUID_RE.test(sessionId)) return { ok: false, reason: "invalid" };
  // Find the owner's key without locks, then lock in the standard order and re-check.
  const pre = await db.query<{ username: string }>("select username from owner where id = 1");
  if (!pre.rows[0]) return { ok: false, reason: "invalid" };
  const key = pre.rows[0].username;

  return atomic(db, async (qc): Promise<ChangePasswordResult> => {
    const q = qc as Db;
    await lockKeys(q, key, ip);
    await lockOwner(q);
    const { rows } = await q.query<{ username: string; password_hash: string; live: boolean }>(
      `select o.username, o.password_hash,
              exists (select 1 from sessions s where s.id = $1 and s.revoked_at is null
                        and s.absolute_expires_at > clock_timestamp() and s.last_seen_at > clock_timestamp() - interval '8 hours') as live
         from owner o where o.id = 1 for update`,
      [sessionId],
    );
    const o = rows[0];
    if (!o || !o.live || o.username !== key) return { ok: false, reason: "invalid" };

    const wait = await checkLocks(q, key, ip);
    if (wait > 0) return { ok: false, reason: "locked" }; // not recorded: never extends the lock
    const okCur = typeof current === "string" && current.length <= MAX_PW_UNITS && (await passwordSemaphore.run(() => verifyPassword(current, o.password_hash)));
    if (!okCur) {
      if (typeof current !== "string" || current.length > MAX_PW_UNITS) await passwordSemaphore.run(() => dummyVerify());
      await record(q, key, ip, false);
      await audit(q, "password.change_failure", { reason: "invalid" });
      return { ok: false, reason: "invalid" };
    }
    if (typeof next !== "string" || !validatePassword(next, o.username).ok) return { ok: false, reason: "weak_password" };
    let hash: string;
    try {
      hash = await passwordSemaphore.run(() => hashPassword(next));
    } catch {
      return { ok: false, reason: "weak_password" };
    }
    await q.query("update owner set password_hash = $1, updated_at = clock_timestamp() where id = 1", [hash]);
    await q.query("update sessions set revoked_at = clock_timestamp() where id <> $1 and revoked_at is null", [sessionId]);
    const { token, tokenHash } = newToken();
    const rot = await q.query("update sessions set token_hash = $1 where id = $2 and revoked_at is null", [tokenHash, sessionId]);
    if ((rot.rowCount ?? 0) !== 1) throw new Error("session vanished"); // rolls everything back
    await record(q, key, ip, true);
    await audit(q, "password.changed");
    return { ok: true, token };
  });
}

// Retention: dead sessions (past absolute/idle expiry, or revoked > 30 d), login_attempts > 30 d, audit_log > 90 d.
// Takes NO owner/login lock (plain deletes), so it never blocks a login.
export async function purgeExpired(db: Db): Promise<{ sessions: number; attempts: number; audit: number }> {
  const s = await db.query(
    `delete from sessions
      where absolute_expires_at <= clock_timestamp()
         or last_seen_at <= clock_timestamp() - interval '8 hours'
         or revoked_at <= clock_timestamp() - interval '30 days'`,
  );
  const a = await db.query("delete from login_attempts where at <= clock_timestamp() - interval '30 days'");
  const l = await db.query("delete from audit_log where at <= clock_timestamp() - interval '90 days'");
  return { sessions: s.rowCount ?? 0, attempts: a.rowCount ?? 0, audit: l.rowCount ?? 0 };
}

// Opportunistic purge after a successful login: fire-and-forget, at most once per interval per process.
type PurgeState = { last: number | null; intervalMs: number; now: () => number; purge: typeof purgeExpired };
const g = globalThis as { __authPurge?: PurgeState };
const purgeState = (): PurgeState => (g.__authPurge ??= { last: null, intervalMs: 3_600_000, now: Date.now, purge: purgeExpired });
/** Test hook: replaces the purge function / clock / interval and resets the throttle. */
export function configureAuthPurge(o: { purge?: typeof purgeExpired; now?: () => number; intervalMs?: number } = {}): void {
  g.__authPurge = { last: null, intervalMs: o.intervalMs ?? 3_600_000, now: o.now ?? Date.now, purge: o.purge ?? purgeExpired };
}
function maybePurge(db: Db): void {
  const st = purgeState();
  const t = st.now();
  if (st.last !== null && t - st.last < st.intervalMs) return;
  st.last = t;
  void Promise.resolve()
    .then(() => st.purge(db))
    .catch((err: unknown) => console.error(JSON.stringify({ event: "auth.purge_failed", error: err instanceof Error ? err.message : "unknown error" })));
}
