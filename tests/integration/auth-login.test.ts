import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const spies = vi.hoisted(() => ({ verify: null as null | ReturnType<typeof vi.fn>, dummy: null as null | ReturnType<typeof vi.fn> }));
vi.mock("@/server/core/auth-crypto", async (orig) => {
  const a = await orig<typeof import("@/server/core/auth-crypto")>();
  spies.verify = vi.fn(a.verifyPassword);
  spies.dummy = vi.fn(a.dummyVerify);
  return { ...a, verifyPassword: spies.verify, dummyVerify: spies.dummy };
});

import { hashPassword } from "@/server/core/auth-crypto";
import { lockoutDelayMs } from "@/server/core/auth-rules";
import { totpCode } from "@/server/core/totp";
import {
  authInFlight, configureAuthAdmission, configureAuthPurge, changePassword, listSessions, login, logout, purgeExpired, revokeOtherSessions, revokeSession, validateSession,
} from "@/server/db/auth";
import { runAuthPurge } from "@/server/db/owner-cli";
import { consumeSetupLink, createSetupLink } from "@/server/db/owner";
import { beginTotpEnrollment, enableTotp } from "@/server/db/totp";
import { withTestDb, type TestDb } from "../support/db";

const BASE = "http://localhost:3000";
const PW = "correct horse battery staple";
const NEWPW = "another long passphrase 42";
let db: TestDb;
beforeAll(async () => {
  db = await withTestDb();
});
beforeEach(async () => {
  await db.reset();
  spies.verify!.mockClear();
  spies.dummy!.mockClear();
  configureAuthAdmission({ maxInFlightAuth: 1000, maxPerIp: 1000 }); // admission has its own describe
  configureAuthPurge({ purge: async () => ({ sessions: 0, attempts: 0, audit: 0 }) }); // purge has its own describe
});
afterAll(async () => {
  await db?.stop();
});
const q = (sql: string, params: unknown[] = []) => db.pool.query(sql, params);
const verifies = () => spies.verify!.mock.calls.length;

async function makeOwner(): Promise<void> {
  const l = await createSetupLink(db.pool, "create", BASE);
  expect(await consumeSetupLink(db.pool, l.slice(`${BASE}/setup/`.length), { username: "alice", password: PW })).toEqual({ ok: true });
}
const attempt = (o: Partial<Parameters<typeof login>[1]> = {}) =>
  login(db.pool, { username: "alice", password: PW, ip: "10.0.0.1", userAgent: "ua", ...o });
const wrong = (o: Partial<Parameters<typeof login>[1]> = {}) => attempt({ password: "wrong password here", ...o });
async function fail(key: string, ip: string, n: number) {
  for (let i = 0; i < n; i++) await q("insert into login_attempts (username_key, ip, at, success) values ($1,$2,clock_timestamp(),false)", [key, ip]);
}
const back = (secs: number) => q("update login_attempts set at = at - make_interval(secs => $1)", [secs]);
async function session(): Promise<{ token: string }> {
  const r = await attempt();
  if (!r.ok) throw new Error("login failed");
  return r;
}
async function failures(): Promise<number> {
  return Number((await q("select count(*) n from login_attempts where not success")).rows[0].n);
}

describe("login basics", () => {
  it("happy_path_creates_session_stores_only_hash", async () => {
    await makeOwner();
    const r = await attempt({ username: "  ALICE ", userAgent: "x".repeat(400) });
    if (!r.ok) throw new Error("expected ok");
    expect(r.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const idle = r.expiresAt.getTime();
    const abs = r.absoluteExpiresAt.getTime();
    expect(abs - idle).toBeGreaterThan(6.6 * 86400000);
    const { rows } = await q("select * from sessions");
    expect(rows).toHaveLength(1);
    expect(rows[0].user_agent).toHaveLength(255);
    expect(rows[0].ip).toBe("10.0.0.1");
    for (const v of Object.values(rows[0])) expect(String(v)).not.toContain(r.token);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await validateSession(db.pool, r.token)).toEqual({ ok: true, sessionId: rows[0].id });
  });

  it("wrong_password_unknown_user_invalid_username_are_identical_and_unknown_runs_dummy", async () => {
    await makeOwner();
    const a = await wrong({ ip: "1.1.1.1" });
    expect(spies.dummy!).not.toHaveBeenCalled();
    const b = await attempt({ username: "nobody", ip: "1.1.1.2" });
    expect(spies.dummy!).toHaveBeenCalledTimes(1);
    const c = await attempt({ username: "bad name!\u0000", ip: "1.1.1.3" });
    expect(spies.dummy!).toHaveBeenCalledTimes(2);
    expect(a).toEqual({ ok: false, reason: "invalid" });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(await q("select count(*) n from sessions").then((r) => r.rows[0].n)).toBe("0");
  });

  it("no_owner_is_invalid_and_non_string_inputs_do_not_throw", async () => {
    expect(await attempt()).toEqual({ ok: false, reason: "invalid" });
    await makeOwner();
    expect(await login(db.pool, { username: 5 as never, password: {} as never, ip: undefined })).toEqual({ ok: false, reason: "invalid" });
    expect(await attempt({ password: "x".repeat(5000) })).toEqual({ ok: false, reason: "invalid" });
  });

  it("case_and_unicode_variants_share_one_lockout_key", async () => {
    await makeOwner();
    for (const u of ["alice", "ALICE", " Alice ", "ａｌｉｃｅ"]) await wrong({ username: u, ip: `9.9.9.${u.length}` });
    // 4 failures (different ips): one more via a variant -> 5 -> locked for ALL variants
    await wrong({ username: "aLiCe", ip: "9.9.9.99" });
    const r = await attempt({ username: "ALICE", ip: "9.9.9.200" });
    expect(r).toMatchObject({ ok: false, reason: "locked" });
  });

  it("opportunistic_rehash_after_success_and_never_fails_login", async () => {
    await makeOwner();
    const weak = (await hashPassword(PW)).replace("$131072$", "$16384$"); // wrong params -> verify fails; use real weak hash instead
    void weak;
    const { scryptSync, randomBytes } = await import("node:crypto");
    const salt = randomBytes(16);
    const key = scryptSync(PW.normalize("NFKC"), salt, 64, { N: 16384, r: 8, p: 1 });
    const old = `scrypt$16384$8$1$${salt.toString("base64")}$${key.toString("base64")}`;
    await q("update owner set password_hash = $1", [old]);
    expect((await attempt()).ok).toBe(true);
    const now = (await q("select password_hash h from owner")).rows[0].h as string;
    expect(now).not.toBe(old);
    expect(now).toContain("$131072$");
    expect((await attempt()).ok).toBe(true);
  });
});

describe("lockout", () => {
  it("fifth_failure_locks_and_locked_attempts_never_verify", async () => {
    await makeOwner();
    for (let i = 0; i < 5; i++) expect(await wrong()).toEqual({ ok: false, reason: "invalid" });
    expect(verifies()).toBe(5);
    const r = await attempt(); // CORRECT password while locked
    expect(r).toMatchObject({ ok: false, reason: "locked" });
    expect(verifies()).toBe(5);
    expect(await q("select count(*) n from sessions").then((x) => x.rows[0].n)).toBe("0");
  });

  it("repeated_real_failures_follow_the_delay_table", async () => {
    await makeOwner();
    for (let i = 0; i < 5; i++) await wrong();
    for (const n of [5]) {
      // age the streak so the lock for n failures has just ended, then fail for real: failure n+1
      await back(lockoutDelayMs(n) / 1000 + 1);
      const before = verifies();
      expect(await wrong()).toEqual({ ok: false, reason: "invalid" });
      expect(verifies()).toBe(before + 1);
      const l = await attempt({ password: "x y z w v u t s" }); // locked now, delay for n+1 failures
      expect(l).toMatchObject({ ok: false, reason: "locked" });
      if (!l.ok) {
        // 6 failures are on record, so the reported delay is the 6-failure delay
        expect(l.retryAfterMs).toBeLessThanOrEqual(lockoutDelayMs(n + 1));
        expect(l.retryAfterMs).toBeGreaterThan(lockoutDelayMs(n + 1) - 5000);
      }
      break;
    }
  });

  it("delay_table_matches_lockoutDelayMs_via_time_travel", async () => {
    await makeOwner();
    for (const n of [5, 6, 7, 12, 30]) {
      await db.ownerPool.query("truncate login_attempts");
      await fail("alice", "7.7.7.7", n);
      const r = await attempt({ ip: "8.8.8.8" });
      expect(r).toMatchObject({ ok: false, reason: "locked" });
      if (r.ok) return;
      const d = lockoutDelayMs(n);
      expect(r.retryAfterMs).toBeLessThanOrEqual(d);
      expect(r.retryAfterMs).toBeGreaterThan(d - 5000);
      await back(d / 1000 + 1); // locked attempts are not recorded: the lock ends `d` after the last real failure
      expect((await attempt({ ip: "8.8.8.8" })).ok).toBe(true);
    }
  });

  it("boundary_4_failures_not_locked", async () => {
    await makeOwner();
    await fail("alice", "7.7.7.7", 4);
    expect((await attempt({ ip: "8.8.8.8" })).ok).toBe(true);
  });

  it("per_ip_lockout_independent_of_username_and_other_ip_free", async () => {
    await makeOwner();
    for (const u of ["u1", "u2", "u3", "u4", "u5"]) expect(await attempt({ username: u, ip: "5.5.5.5" })).toEqual({ ok: false, reason: "invalid" });
    const locked = await attempt({ username: "alice", ip: "5.5.5.5" });
    expect(locked).toMatchObject({ ok: false, reason: "locked" });
    expect(await attempt({ username: "alice", ip: "6.6.6.6" })).toMatchObject({ ok: true });
  });

  it("missing_ip_uses_shared_unknown_bucket", async () => {
    await makeOwner();
    await fail("zzz", "unknown", 5);
    expect(await attempt({ ip: undefined })).toMatchObject({ ok: false, reason: "locked" });
  });

  it("success_resets_username_streak", async () => {
    await makeOwner();
    await fail("alice", "3.3.3.3", 4);
    expect((await attempt({ ip: "4.4.4.4" })).ok).toBe(true);
    await fail("alice", "3.3.3.3", 4); // 4 again after the success: still free
    expect((await attempt({ ip: "4.4.4.5" })).ok).toBe(true);
  });

  it("failures_older_than_24h_do_not_count", async () => {
    await makeOwner();
    await fail("alice", "3.3.3.3", 6);
    await back(25 * 3600);
    expect((await attempt()).ok).toBe(true);
  });

  it("twenty_concurrent_wrong_attempts_exactly_5_verifies_5_failures_rest_locked", async () => {
    await makeOwner();
    const rs = await Promise.all(Array.from({ length: 20 }, () => wrong()));
    expect(rs.filter((r) => !r.ok && r.reason === "invalid")).toHaveLength(5);
    expect(rs.filter((r) => !r.ok && r.reason === "locked")).toHaveLength(15);
    expect(verifies()).toBe(5);
    expect(await failures()).toBe(5); // locked attempts are refused, not recorded
    expect(Number((await q("select count(*) n from login_attempts")).rows[0].n)).toBe(5);
    expect(Number((await q("select count(*) n from audit_log where detail->>'reason' = 'locked'")).rows[0].n)).toBe(0);
  });

  it("concurrent_attempts_on_different_usernames_from_one_ip_are_capped_by_ip", async () => {
    await makeOwner();
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => attempt({ username: `user${i}`, ip: "2.2.2.2" })));
    expect(rs.filter((r) => !r.ok && r.reason === "invalid")).toHaveLength(5);
    expect(rs.filter((r) => !r.ok && r.reason === "locked")).toHaveLength(7);
  });
});

describe("second factor", () => {
  const NOW = Date.now();
  async function enable() {
    await makeOwner();
    const { secret } = await beginTotpEnrollment(db.pool);
    const r = await enableTotp(db.pool, totpCode(secret, NOW - 90_000), NOW - 90_000);
    if (!r.ok) throw new Error("enable");
    return { secret, codes: r.recoveryCodes };
  }

  it("needs_totp_creates_no_session_records_nothing_and_does_not_reset_streak", async () => {
    await enable();
    await fail("alice", "1.2.3.4", 3);
    const before = Number((await q("select count(*) n from login_attempts")).rows[0].n);
    expect(await attempt({ ip: "1.2.3.4" })).toEqual({ ok: false, reason: "needs_totp" });
    expect((await q("select count(*) n from sessions")).rows[0].n).toBe("0");
    expect(Number((await q("select count(*) n from login_attempts")).rows[0].n)).toBe(before);
    expect(await attempt({ ip: "1.2.3.4", code: "" })).toEqual({ ok: false, reason: "needs_totp" });
    // streak intact: 2 more failures reach 5 -> locked
    await wrong({ ip: "1.2.3.4" });
    await wrong({ ip: "1.2.3.4" });
    expect(await attempt({ ip: "1.2.3.4" })).toMatchObject({ reason: "locked" });
  });

  it("wrong_password_with_totp_enabled_is_plain_invalid", async () => {
    await enable();
    expect(await wrong({ code: "123456" })).toEqual({ ok: false, reason: "invalid" });
  });

  it("totp_code_logs_in_once_replay_fails_and_wrong_code_counts_as_failure", async () => {
    const { secret } = await enable();
    const t = Date.now();
    const code = totpCode(secret, t);
    expect(await attempt({ code, now: new Date(t) })).toMatchObject({ ok: true });
    expect(await attempt({ code, now: new Date(t) })).toEqual({ ok: false, reason: "invalid" }); // replay
    expect(await failures()).toBe(1);
    expect(await attempt({ code: "000000", now: new Date(t) })).toEqual({ ok: false, reason: "invalid" });
    expect(await failures()).toBe(2);
    expect((await q("select count(*) n from sessions")).rows[0].n).toBe("1");
  });

  it("second_factor_guesses_lock_out", async () => {
    await enable();
    for (let i = 0; i < 5; i++) await attempt({ code: "000000" });
    expect(await attempt({ code: "000000" })).toMatchObject({ reason: "locked" });
  });

  it("recovery_code_logs_in_once", async () => {
    const { codes } = await enable();
    expect(await attempt({ code: codes[0]! })).toMatchObject({ ok: true });
    expect(await attempt({ code: codes[0]! })).toEqual({ ok: false, reason: "invalid" });
    expect(await attempt({ code: codes[1]!.toLowerCase() })).toMatchObject({ ok: true });
  });
});

describe("sessions", () => {
  beforeEach(async () => {
    await makeOwner();
  });

  it("validate_unknown_garbage_oversized_revoked", async () => {
    const { token } = await session();
    expect(await validateSession(db.pool, "nope")).toEqual({ ok: false });
    expect(await validateSession(db.pool, "")).toEqual({ ok: false });
    expect(await validateSession(db.pool, "x".repeat(10_000))).toEqual({ ok: false });
    expect(await validateSession(db.pool, undefined as never)).toEqual({ ok: false });
    expect(await validateSession(db.pool, { a: 1 } as never)).toEqual({ ok: false });
    expect((await validateSession(db.pool, token)).ok).toBe(true);
    await q("update sessions set revoked_at = now()");
    expect(await validateSession(db.pool, token)).toEqual({ ok: false });
  });

  it("idle_expiry_via_time_travel_and_exact_boundary", async () => {
    const { token } = await session();
    await q("update sessions set created_at = created_at - interval '9 hours', last_seen_at = last_seen_at - interval '9 hours'");
    expect(await validateSession(db.pool, token)).toEqual({ ok: false });
    await q("update sessions set created_at = '2030-01-01T00:00:00Z', last_seen_at = '2030-01-01T00:00:00Z'");
    const t0 = new Date("2030-01-01T00:00:00Z").getTime();
    expect((await validateSession(db.pool, token, { now: new Date(t0 + 8 * 3600_000 - 1) })).ok).toBe(true);
    expect((await validateSession(db.pool, token, { now: new Date(t0 + 8 * 3600_000) })).ok).toBe(false);
  });

  it("absolute_expiry_even_if_recently_seen_and_exact_boundary", async () => {
    const { token } = await session();
    await q("update sessions set created_at = created_at - interval '8 days', absolute_expires_at = absolute_expires_at - interval '8 days'");
    expect(await validateSession(db.pool, token)).toEqual({ ok: false });
    await q("update sessions set created_at = '2030-01-01T00:00:00Z', last_seen_at = '2030-01-07T23:00:00Z'");
    const t0 = new Date("2030-01-01T00:00:00Z").getTime();
    const week = 7 * 86400_000;
    expect((await validateSession(db.pool, token, { now: new Date(t0 + week - 1) })).ok).toBe(true);
    expect((await validateSession(db.pool, token, { now: new Date(t0 + week) })).ok).toBe(false);
  });

  it("last_seen_updates_at_most_once_a_minute", async () => {
    const { token } = await session();
    const seen = async () => (await q("select last_seen_at t from sessions")).rows[0].t as Date;
    const first = await seen();
    await q("update sessions set created_at = created_at - interval '5 minutes', last_seen_at = last_seen_at - interval '30 seconds'");
    const t30 = await seen();
    await validateSession(db.pool, token);
    expect((await seen()).getTime()).toBe(t30.getTime()); // under 60 s: untouched
    await q("update sessions set last_seen_at = last_seen_at - interval '40 seconds'"); // now ~70 s old
    const t70 = await seen();
    await validateSession(db.pool, token);
    expect((await seen()).getTime()).toBeGreaterThan(t70.getTime() + 60_000);
    void first;
    expect(Date.now() - (await seen()).getTime()).toBeLessThan(5000);
  });

  it("logout_revokes_and_bad_token_is_noop", async () => {
    const { token } = await session();
    await logout(db.pool, "garbage");
    await logout(db.pool, "x".repeat(999));
    expect((await validateSession(db.pool, token)).ok).toBe(true);
    await logout(db.pool, token);
    expect((await validateSession(db.pool, token)).ok).toBe(false);
  });

  it("list_has_no_token_material_revoke_and_revoke_others", async () => {
    const a = await session();
    const b = await session();
    const c = await session();
    const list = await listSessions(db.pool);
    expect(list).toHaveLength(3);
    const json = JSON.stringify(list);
    for (const t of [a.token, b.token, c.token]) expect(json).not.toContain(t);
    expect(json).not.toContain("token_hash");
    expect(json.toLowerCase()).not.toContain("tokenhash");
    const ida = (await validateSession(db.pool, a.token)) as { sessionId: string };
    const idb = (await validateSession(db.pool, b.token)) as { sessionId: string };
    expect(await revokeSession(db.pool, idb.sessionId)).toBe(true);
    expect(await revokeSession(db.pool, "not-a-uuid")).toBe(false);
    expect((await validateSession(db.pool, b.token)).ok).toBe(false);
    expect(await revokeOtherSessions(db.pool, ida.sessionId)).toBe(1);
    expect((await validateSession(db.pool, a.token)).ok).toBe(true);
    expect((await validateSession(db.pool, c.token)).ok).toBe(false);
    expect(await listSessions(db.pool)).toHaveLength(1);
  });

  it("changePassword_wrong_current_counts_failure_weak_next_rejected", async () => {
    const { token } = await session();
    const { sessionId } = (await validateSession(db.pool, token)) as { sessionId: string };
    expect(await changePassword(db.pool, sessionId, "not the password", NEWPW)).toEqual({ ok: false, reason: "invalid" });
    expect(await failures()).toBe(1);
    expect(await changePassword(db.pool, sessionId, PW, "short")).toEqual({ ok: false, reason: "weak_password" });
    expect(await changePassword(db.pool, sessionId, PW, "alice")).toEqual({ ok: false, reason: "weak_password" });
    expect((await attempt()).ok).toBe(true); // old password still works
  });

  it("changePassword_wrong_current_5_times_locks", async () => {
    const { token } = await session();
    const { sessionId } = (await validateSession(db.pool, token)) as { sessionId: string };
    for (let i = 0; i < 5; i++) await changePassword(db.pool, sessionId, "nope nope nope", NEWPW, "10.0.0.1");
    const before = verifies();
    expect(await changePassword(db.pool, sessionId, PW, NEWPW, "10.0.0.1")).toEqual({ ok: false, reason: "locked" });
    expect(await failures()).toBe(5);
    expect(verifies()).toBe(before);
  });

  it("changePassword_revokes_others_rotates_current_and_switches_password", async () => {
    const cur = await session();
    const other = await session();
    const { sessionId } = (await validateSession(db.pool, cur.token)) as { sessionId: string };
    const r = await changePassword(db.pool, sessionId, PW, NEWPW);
    if (!r.ok) throw new Error("expected ok");
    expect(r.token).not.toBe(cur.token);
    expect((await validateSession(db.pool, cur.token)).ok).toBe(false); // old token dead
    expect(await validateSession(db.pool, r.token)).toEqual({ ok: true, sessionId });
    expect((await validateSession(db.pool, other.token)).ok).toBe(false);
    const row = (await q("select * from sessions where id = $1", [sessionId])).rows[0];
    for (const v of Object.values(row)) expect(String(v)).not.toContain(r.token);
    expect((await attempt()).ok).toBe(false);
    expect((await attempt({ password: NEWPW, ip: "10.9.9.9" })).ok).toBe(true);
  });

  it("changePassword_with_revoked_or_unknown_session_is_invalid", async () => {
    const { token } = await session();
    const { sessionId } = (await validateSession(db.pool, token)) as { sessionId: string };
    await logout(db.pool, token);
    expect(await changePassword(db.pool, sessionId, PW, NEWPW)).toEqual({ ok: false, reason: "invalid" });
    expect(await changePassword(db.pool, "00000000-0000-4000-8000-000000000000", PW, NEWPW)).toEqual({ ok: false, reason: "invalid" });
  });

  it("purgeExpired_removes_dead_sessions_and_old_attempts_only", async () => {
    const live = await session();
    const idle = await session();
    const abs = await session();
    const oldRevoked = await session();
    await session(); // revoked recently
    const h = async (t: string) => (await q("select id from sessions where token_hash = encode(sha256($1::bytea),'hex')", [t])).rows[0].id as string;
    await q("update sessions set created_at = created_at - interval '9 hours', last_seen_at = last_seen_at - interval '9 hours' where id = $1", [await h(idle.token)]);
    await q("update sessions set created_at = created_at - interval '8 days', absolute_expires_at = absolute_expires_at - interval '8 days' where id = $1", [await h(abs.token)]);
    await q("update sessions set revoked_at = now() - interval '31 days', created_at = created_at - interval '32 days', last_seen_at = last_seen_at - interval '32 days' where id = $1", [await h(oldRevoked.token)]);
    await q("update sessions set revoked_at = now() where id = (select id from sessions order by created_at desc limit 1)");
    await q("insert into login_attempts (username_key, ip, at, success) values ('a','i', now() - interval '31 days', false), ('a','i', now() - interval '29 days', false)");
    const r = await purgeExpired(db.ownerPool);
    expect(r.sessions).toBe(3);
    expect(r.attempts).toBe(1);
    expect((await validateSession(db.pool, live.token)).ok).toBe(true);
    // the idle-revoked-recently row stays
    expect(Number((await q("select count(*) n from sessions")).rows[0].n)).toBe(2);
  });
});

describe("lockout does not become a denial of service", () => {
  it("locked_attempts_are_not_recorded_and_do_not_extend_the_lock", async () => {
    await makeOwner();
    await fail("alice", "7.7.7.7", 5);
    const n0 = Number((await q("select count(*) n from login_attempts")).rows[0].n);
    for (let i = 0; i < 3; i++) expect(await attempt({ ip: `8.8.8.${i}` })).toMatchObject({ reason: "locked" });
    expect(Number((await q("select count(*) n from login_attempts")).rows[0].n)).toBe(n0);
  });

  it("lock_expires_delay_after_last_real_failure", async () => {
    await makeOwner();
    await fail("alice", "7.7.7.7", 5);
    for (let i = 0; i < 8; i++) await attempt({ ip: `8.8.8.${i}` }); // hammering while locked
    await back(61); // 60 s delay for 5 real failures has passed
    expect((await attempt({ ip: "8.8.8.99" })).ok).toBe(true);
  });

  it("known_good_ip_bypasses_username_lock_but_not_ip_lock", async () => {
    await makeOwner();
    expect((await attempt({ ip: "1.1.1.1" })).ok).toBe(true);
    await fail("alice", "9.9.9.9", 8); // attacker failures from elsewhere lock the username
    expect((await attempt({ ip: "1.1.1.1" })).ok).toBe(true);
    await fail("other", "1.1.1.1", 5); // now the ip itself is locked
    expect(await attempt({ ip: "1.1.1.1" })).toMatchObject({ ok: false, reason: "locked" });
  });

  it("unknown_ip_is_locked_by_username_lock", async () => {
    await makeOwner();
    expect((await attempt({ ip: "1.1.1.1" })).ok).toBe(true);
    await fail("alice", "9.9.9.9", 5);
    expect(await attempt({ ip: "2.2.2.2" })).toMatchObject({ ok: false, reason: "locked" });
  });

  it("known_good_status_expires_after_30_days", async () => {
    await makeOwner();
    expect((await attempt({ ip: "1.1.1.1" })).ok).toBe(true);
    await q("update login_attempts set at = at - interval '31 days' where success");
    await fail("alice", "9.9.9.9", 5);
    expect(await attempt({ ip: "1.1.1.1" })).toMatchObject({ ok: false, reason: "locked" });
  });

  it("attacker_rotating_ips_cannot_keep_a_known_good_ip_locked_out", async () => {
    await makeOwner();
    expect((await attempt({ ip: "1.1.1.1" })).ok).toBe(true);
    for (let i = 0; i < 30; i++) await attempt({ password: "bad bad bad bad", ip: `66.0.0.${i}`, username: "alice" });
    expect((await attempt({ ip: "1.1.1.1" })).ok).toBe(true);
  });

  it("wrong_password_from_known_good_ip_still_counts_as_failure", async () => {
    await makeOwner();
    expect((await attempt({ ip: "1.1.1.1" })).ok).toBe(true);
    expect(await wrong({ ip: "1.1.1.1" })).toEqual({ ok: false, reason: "invalid" });
    expect(await failures()).toBe(1);
    for (let i = 0; i < 4; i++) await wrong({ ip: "1.1.1.1" }); // 5 failures on the ip lock it
    expect(await attempt({ ip: "1.1.1.1" })).toMatchObject({ reason: "locked" });
    // and the username streak (5) locks unknown ips
    expect(await attempt({ ip: "3.3.3.3" })).toMatchObject({ reason: "locked" });
  });
});

describe("admission control", () => {
  const url = () => db.pool.options.connectionString!;

  it("flood_of_logins_does_not_starve_other_queries", async () => {
    await makeOwner();
    configureAuthAdmission({ maxInFlightAuth: 3, maxPerIp: 1 });
    const small = new pg.Pool({ connectionString: url(), max: 4 });
    try {
      const flood = Promise.all(Array.from({ length: 40 }, (_, i) => login(small, { username: `user${i}`, password: "wrong wrong wrong", ip: `20.0.0.${i}` })));
      await new Promise((r) => setTimeout(r, 50));
      const t0 = Date.now();
      await small.query("select 1");
      expect(Date.now() - t0).toBeLessThan(500);
      const rs = await flood;
      expect(rs.some((r) => !r.ok && r.reason === "busy")).toBe(true);
      expect(rs.every((r) => !r.ok)).toBe(true);
    } finally {
      await small.end();
    }
  }, 60_000);

  it("one_ip_cannot_fill_the_global_cap", async () => {
    await makeOwner();
    configureAuthAdmission({ maxInFlightAuth: 3, maxPerIp: 1 });
    const same = Array.from({ length: 10 }, () => wrong({ ip: "50.0.0.1" }));
    const other = wrong({ ip: "50.0.0.2" });
    const rs = await Promise.all(same);
    expect(rs.filter((r) => !r.ok && r.reason === "busy")).toHaveLength(9);
    expect(await other).toEqual({ ok: false, reason: "invalid" }); // another ip still got a slot
  });

  it("busy_result_never_touches_the_db", async () => {
    await makeOwner();
    configureAuthAdmission({ maxInFlightAuth: 1, maxPerIp: 1 });
    let touches = 0;
    const counting = new Proxy(db.pool, {
      get(t, p) {
        if (p === "connect" || p === "query") touches++;
        const v = (t as never)[p];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    const holder = wrong({ ip: "60.0.0.1" });
    const busy = await login(counting, { username: "alice", password: PW, ip: "60.0.0.2" });
    const busyCp = await changePassword(counting, "00000000-0000-4000-8000-000000000000", PW, NEWPW, "60.0.0.3");
    expect(busy).toEqual({ ok: false, reason: "busy" });
    expect(busyCp).toEqual({ ok: false, reason: "busy" });
    expect(touches).toBe(0);
    await holder;
  });

  it("slot_is_released_on_error_and_on_success", async () => {
    await makeOwner();
    configureAuthAdmission({ maxInFlightAuth: 3, maxPerIp: 1 });
    const broken = { connect: async () => { throw new Error("db down"); }, query: async () => { throw new Error("db down"); } } as unknown as pg.Pool;
    await fail("x", "70.0.0.1", 5); // ip locked: cheap refusals, no scrypt
    for (let i = 0; i < 100; i++) {
      await expect(login(broken, { username: "alice", password: PW, ip: "70.0.0.9" })).rejects.toThrow();
      expect(await attempt({ ip: "70.0.0.1" })).toMatchObject({ reason: "locked" });
    }
    expect((await attempt({ ip: "70.0.0.5" })).ok).toBe(true);
    expect(authInFlight()).toBe(0);
    const rs = await Promise.all(["a", "b", "c"].map((x) => attempt({ ip: `71.0.0.${x}` })));
    expect(rs.every((r) => r.ok)).toBe(true); // all 3 slots usable again
  }, 60_000);
});

describe("ip hardening", () => {
  it("ipv4_mapped_ipv6_and_plain_ipv4_share_one_lock", async () => {
    await makeOwner();
    for (let i = 0; i < 5; i++) await attempt({ username: `user${i}`, ip: "::ffff:9.9.9.9" });
    expect(await attempt({ ip: "9.9.9.9" })).toMatchObject({ ok: false, reason: "locked" });
    expect(await attempt({ ip: " ::FFFF:909:909 " })).toMatchObject({ ok: false, reason: "locked" });
  });

  it("unknown_ip_success_does_not_bypass_username_lock", async () => {
    await makeOwner();
    expect((await attempt({ ip: undefined })).ok).toBe(true);
    await fail("alice", "9.9.9.9", 5);
    expect(await attempt({ ip: undefined })).toMatchObject({ ok: false, reason: "locked" });
  });

  it("changePassword_without_ip_is_not_known_good", async () => {
    await makeOwner();
    const r = await attempt({ ip: undefined });
    if (!r.ok) throw new Error("login");
    const { sessionId } = (await validateSession(db.pool, r.token)) as { sessionId: string };
    await fail("alice", "9.9.9.9", 5);
    expect(await changePassword(db.pool, sessionId, PW, NEWPW)).toEqual({ ok: false, reason: "locked" });
  });
});

describe("purge", () => {
  async function seed() {
    const live = await session();
    const idle = await session();
    const abs = await session();
    const oldRevoked = await session();
    const recentRevoked = await session();
    const h = async (t: string) => (await q("select id from sessions where token_hash = encode(sha256($1::bytea),'hex')", [t])).rows[0].id as string;
    await q("update sessions set created_at = created_at - interval '9 hours', last_seen_at = last_seen_at - interval '9 hours' where id = $1", [await h(idle.token)]);
    await q("update sessions set created_at = created_at - interval '8 days', absolute_expires_at = absolute_expires_at - interval '8 days' where id = $1", [await h(abs.token)]);
    await q("update sessions set revoked_at = now() - interval '31 days' where id = $1", [await h(oldRevoked.token)]);
    await q("update sessions set revoked_at = now() - interval '29 days' where id = $1", [await h(recentRevoked.token)]);
    await q("delete from login_attempts");
    await q("insert into login_attempts (username_key, ip, at, success) values ('a','i', now() - interval '31 days', false), ('b','i', now() - interval '29 days', false)");
    await db.ownerPool.query("delete from audit_log");
    await db.ownerPool.query("insert into audit_log (at, event) values (now() - interval '91 days', 'old'), (now() - interval '89 days', 'recent')");
    return { live, recentRevoked };
  }

  it("purge_deletes_expired_sessions_and_old_attempts_and_old_audit_rows", async () => {
    await makeOwner();
    const { live, recentRevoked } = await seed();
    const r = await purgeExpired(db.ownerPool);
    expect(r).toEqual({ sessions: 3, attempts: 1, audit: 1 });
    // rows inside the retention windows survive
    expect((await validateSession(db.pool, live.token)).ok).toBe(true);
    expect(Number((await q("select count(*) n from sessions")).rows[0].n)).toBe(2);
    expect((await q("select username_key k from login_attempts")).rows.map((x) => x.k)).toEqual(["b"]);
    expect((await q("select event from audit_log")).rows.map((x) => x.event)).toEqual(["recent"]);
    void recentRevoked;
  });

  it("login_triggers_purge_at_most_once_per_hour", async () => {
    await makeOwner();
    let clock = 1_000_000;
    const purge = vi.fn(async () => ({ sessions: 0, attempts: 0, audit: 0 }));
    configureAuthPurge({ purge, now: () => clock });
    const tick = () => new Promise((r) => setImmediate(r));
    await wrong({ ip: "1.0.0.1" });
    await tick();
    expect(purge).toHaveBeenCalledTimes(0); // failures never trigger it
    expect((await attempt({ ip: "1.0.0.2" })).ok).toBe(true);
    await tick();
    expect(purge).toHaveBeenCalledTimes(1);
    // the app role may not delete audit_log, so the login-triggered purge must skip it
    expect(purge).toHaveBeenCalledWith(expect.anything(), { audit: false });
    expect((await attempt({ ip: "1.0.0.3" })).ok).toBe(true);
    await tick();
    expect(purge).toHaveBeenCalledTimes(1);
    clock += 3_600_000 - 1;
    await attempt({ ip: "1.0.0.4" });
    await tick();
    expect(purge).toHaveBeenCalledTimes(1);
    clock += 2;
    await attempt({ ip: "1.0.0.5" });
    await tick();
    expect(purge).toHaveBeenCalledTimes(2);
  });

  it("purge_failure_does_not_fail_the_login", async () => {
    await makeOwner();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    configureAuthPurge({ purge: async () => { throw new Error("purge boom"); } });
    try {
      expect((await attempt()).ok).toBe(true);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(err).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(err.mock.calls[0]![0]))).toEqual({ event: "auth.purge_failed", error: "purge boom" });
    } finally {
      err.mockRestore();
    }
  });

  it("auth_purge_cli_function_returns_counts", async () => {
    await makeOwner();
    await seed();
    const r = await runAuthPurge(db.ownerPool);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("purged sessions=3 attempts=1 audit=1\n");
  });
});

describe("audit", () => {
  it("rows_hold_no_secrets", async () => {
    await makeOwner();
    const { secret } = await (async () => beginTotpEnrollment(db.pool))();
    const t = Date.now();
    const code = totpCode(secret, t - 90_000);
    const en = await enableTotp(db.pool, code, t - 90_000);
    if (!en.ok) throw new Error("enable");
    await wrong({ password: "hunter2-secret-pw" });
    await attempt({ username: "totally-secret-username-1", password: "pw-pw-pw-pw-pw" });
    const ok = await attempt({ code: en.recoveryCodes[0]! });
    if (!ok.ok) throw new Error("login");
    const { sessionId } = (await validateSession(db.pool, ok.token)) as { sessionId: string };
    await changePassword(db.pool, sessionId, "wrong wrong wrong", NEWPW);
    const ch = await changePassword(db.pool, sessionId, PW, NEWPW);
    if (!ch.ok) throw new Error("change");
    const all = JSON.stringify((await q("select event, detail from audit_log")).rows);
    expect(all).toContain("login.success");
    expect(all).toContain("login.failure");
    expect(all).toContain("password.changed");
    for (const secretStr of [PW, NEWPW, "hunter2-secret-pw", "totally-secret-username-1", "pw-pw-pw-pw-pw", ok.token, ch.token, secret, ...en.recoveryCodes, en.recoveryCodes[0]!.replace(/-/g, "")]) {
      expect(all).not.toContain(secretStr);
    }
  });
});
