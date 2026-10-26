import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { totpCode } from "@/server/core/totp";
import { consumeSetupLink, createSetupLink } from "@/server/db/owner";
import {
  beginTotpEnrollment,
  disableTotp,
  enableTotp,
  regenerateRecoveryCodes,
  totpEnabled,
  unusedRecoveryCodeCount,
  useRecoveryCode as redeemRecoveryCode,
  verifyOwnerTotp,
} from "@/server/db/totp";
import { withTestDb, type TestDb } from "../support/db";

const BASE = "http://localhost:3000";
const PW = "correct horse battery staple";
let db: TestDb;
beforeAll(async () => {
  db = await withTestDb();
});
beforeEach(async () => {
  await db.reset();
});
afterAll(async () => {
  await db?.stop();
});

const q = (sql: string, params: unknown[] = []) => db.pool.query(sql, params);
const NOW = 1_700_000_000_000;
const step = Math.floor(NOW / 30000);

async function makeOwner(): Promise<void> {
  if ((await q("select 1 from owner")).rows.length > 0) return;
  const l = await createSetupLink(db.pool, "create", BASE);
  expect(await consumeSetupLink(db.pool, l.slice(`${BASE}/setup/`.length), { username: "alice", password: PW })).toEqual({ ok: true });
}
async function enable(): Promise<{ secret: string; codes: string[] }> {
  await makeOwner();
  const { secret } = await beginTotpEnrollment(db.pool);
  const r = await enableTotp(db.pool, totpCode(secret, NOW), NOW);
  if (!r.ok) throw new Error("enable failed");
  return { secret, codes: r.recoveryCodes };
}
const manyPools = (n: number) => Array.from({ length: n }, () => new pg.Pool({ connectionString: db.pool.options.connectionString!, max: 1 }));

describe("enrollment", () => {
  it("begin_stores_only_pending_and_returns_uri", async () => {
    await makeOwner();
    const { secret, uri } = await beginTotpEnrollment(db.pool);
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain("alice");
    const o = (await q("select * from owner")).rows[0];
    expect(o.totp_pending_secret).toBe(secret);
    expect(o.totp_secret).toBeNull();
    expect(await totpEnabled(db.pool)).toBe(false);
    const again = await beginTotpEnrollment(db.pool);
    expect(again.secret).not.toBe(secret);
    expect((await q("select totp_pending_secret from owner")).rows[0].totp_pending_secret).toBe(again.secret);
  });

  it("enroll_and_confirm_enables_and_returns_ten_codes", async () => {
    const { secret, codes } = await enable();
    expect(codes).toHaveLength(10);
    expect(await totpEnabled(db.pool)).toBe(true);
    const o = (await q("select * from owner")).rows[0];
    expect(o.totp_secret).toBe(secret);
    expect(o.totp_pending_secret).toBeNull();
    expect(Number(o.totp_last_step)).toBe(step);
    expect(await unusedRecoveryCodeCount(db.pool)).toBe(10);
  });

  it("wrong_code_does_not_enable_and_keeps_pending", async () => {
    await makeOwner();
    const { secret } = await beginTotpEnrollment(db.pool);
    const wrong = totpCode(secret, NOW) === "000000" ? "000001" : "000000";
    expect(await enableTotp(db.pool, wrong, NOW)).toEqual({ ok: false });
    expect(await enableTotp(db.pool, totpCode(secret, NOW + 5 * 30000), NOW)).toEqual({ ok: false });
    expect(await totpEnabled(db.pool)).toBe(false);
    expect(await unusedRecoveryCodeCount(db.pool)).toBe(0);
    expect((await q("select totp_pending_secret from owner")).rows[0].totp_pending_secret).toBe(secret);
  });

  it("enable_without_pending_fails_and_begin_refused_when_enabled", async () => {
    await makeOwner();
    expect(await enableTotp(db.pool, "123456", NOW)).toEqual({ ok: false });
    await enable();
    await expect(beginTotpEnrollment(db.pool)).rejects.toThrow();
  });

  it("recovery_codes_plaintext_absent_from_db_and_audit_has_no_secret", async () => {
    const { secret, codes } = await enable();
    const dump = JSON.stringify([
      (await q("select * from recovery_codes")).rows,
      (await q("select * from audit_log")).rows,
      (await q("select username, password_hash, created_at from owner")).rows,
    ]);
    for (const c of codes) {
      expect(dump).not.toContain(c);
      expect(dump).not.toContain(c.replace(/-/g, ""));
    }
    expect(dump).not.toContain(secret);
    const ev = (await q("select event, detail from audit_log where event like 'totp.%'")).rows;
    expect(ev).toEqual([{ event: "totp.enabled", detail: {} }]);
  });
});

describe("verifyOwnerTotp", () => {
  it("accepts_a_fresh_step_once_and_rejects_replay_and_older", async () => {
    const { secret } = await enable();
    expect(await verifyOwnerTotp(db.pool, totpCode(secret, NOW + 30000), NOW)).toBe(true); // step+1
    expect(await verifyOwnerTotp(db.pool, totpCode(secret, NOW + 30000), NOW)).toBe(false); // replay
    expect(await verifyOwnerTotp(db.pool, totpCode(secret, NOW), NOW)).toBe(false); // older than last
    expect(Number((await q("select totp_last_step from owner")).rows[0].totp_last_step)).toBe(step + 1);
  });

  it("false_when_not_enabled", async () => {
    await makeOwner();
    expect(await verifyOwnerTotp(db.pool, "123456", NOW)).toBe(false);
  });

  it("concurrent_same_code_exactly_one_wins", async () => {
    const { secret } = await enable();
    const code = totpCode(secret, NOW + 30000);
    const pools = manyPools(20);
    try {
      const res = await Promise.all(pools.map((p) => verifyOwnerTotp(p, code, NOW)));
      expect(res.filter(Boolean)).toHaveLength(1);
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
  });
});

describe("recovery codes", () => {
  it("works_once", async () => {
    const { codes } = await enable();
    const c = codes[0] as string;
    expect(await redeemRecoveryCode(db.pool, c.toLowerCase())).toBe(true);
    expect(await redeemRecoveryCode(db.pool, c)).toBe(false);
    expect(await unusedRecoveryCodeCount(db.pool)).toBe(9);
  });

  it("bad_format_false_without_db_call", async () => {
    const fake = { query: () => Promise.reject(new Error("db touched")) } as unknown as pg.Pool;
    for (const bad of ["", "abc", "AAAA-AAAA-AAAA-AAAA", "0000-0000-0000", "x".repeat(10_000), 5 as unknown as string]) {
      expect(await redeemRecoveryCode(fake, bad)).toBe(false);
    }
  });

  it("well_formed_but_unknown_false", async () => {
    await enable();
    expect(await redeemRecoveryCode(db.pool, "AAAA-AAAA-AAAA")).toBe(false);
  });

  it("concurrent_use_of_one_code_exactly_one_winner", async () => {
    const { codes } = await enable();
    const pools = manyPools(20);
    try {
      const res = await Promise.all(pools.map((p) => redeemRecoveryCode(p, codes[3] as string)));
      expect(res.filter(Boolean)).toHaveLength(1);
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
  });

  it("regenerate_invalidates_all_old_including_unused_and_needs_totp", async () => {
    await makeOwner();
    await expect(regenerateRecoveryCodes(db.pool)).rejects.toThrow();
    const { codes: old } = await enable();
    await redeemRecoveryCode(db.pool, old[0] as string);
    const fresh = await regenerateRecoveryCodes(db.pool);
    expect(fresh).toHaveLength(10);
    expect(await unusedRecoveryCodeCount(db.pool)).toBe(10);
    expect((await q("select count(*)::int as n from recovery_codes")).rows[0].n).toBe(10);
    for (const c of old) expect(await redeemRecoveryCode(db.pool, c)).toBe(false);
    expect(await redeemRecoveryCode(db.pool, fresh[0] as string)).toBe(true);
    expect((await q("select event from audit_log where event = 'totp.recovery_regenerated'")).rows).toHaveLength(1);
  });
});

describe("disable", () => {
  it("requires_proof_then_clears_everything", async () => {
    const { secret, codes } = await enable();
    expect(await disableTotp(db.pool, { proof: "000000", nowMs: NOW })).toBe(false);
    expect(await disableTotp(db.pool, { proof: "", nowMs: NOW })).toBe(false);
    expect(await disableTotp(db.pool, { proof: totpCode(secret, NOW), nowMs: NOW })).toBe(false); // replay of enrollment step
    expect(await totpEnabled(db.pool)).toBe(true);
    expect(await disableTotp(db.pool, { proof: totpCode(secret, NOW + 30000), nowMs: NOW })).toBe(true);
    const o = (await q("select * from owner")).rows[0];
    expect([o.totp_secret, o.totp_pending_secret, o.totp_last_step]).toEqual([null, null, null]);
    expect(await unusedRecoveryCodeCount(db.pool)).toBe(0);
    expect(await disableTotp(db.pool, { proof: codes[0] as string })).toBe(false); // not enabled any more
    expect((await q("select event from audit_log where event = 'totp.disabled'")).rows).toHaveLength(1);
  });

  it("recovery_code_is_accepted_as_proof", async () => {
    const { codes } = await enable();
    expect(await disableTotp(db.pool, { proof: codes[2] as string })).toBe(true);
    expect(await totpEnabled(db.pool)).toBe(false);
  });
});
