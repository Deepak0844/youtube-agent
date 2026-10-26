import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateMasterKey, makeKeyring, type Keyring } from "@/server/core/vault-crypto";
import { generateSecret, totpCode } from "@/server/core/totp";
import { login } from "@/server/db/auth";
import { clearOwnerSecurity, consumeSetupLink, createSetupLink } from "@/server/db/owner";
import { beginTotpEnrollment, disableTotp, enableTotp, setTotpKeyring, totpEnabled, verifyOwnerTotp } from "@/server/db/totp";
import { backfillTotpSecrets } from "@/server/db/totp-backfill";
import { getSecret } from "@/server/db/vault";
import { withTestDb, type TestDb } from "../support/db";

const BASE = "http://localhost:3000";
const PW = "correct horse battery staple";
const NOW = 1_700_000_000_000;
const ring: Keyring = makeKeyring(generateMasterKey());
const otherRing: Keyring = makeKeyring(generateMasterKey());
let db: TestDb;
beforeAll(async () => {
  db = await withTestDb();
});
beforeEach(async () => {
  await db.reset();
  setTotpKeyring(() => ring);
});
afterEach(() => setTotpKeyring(null));
afterAll(async () => {
  await db?.stop();
});
const q = (sql: string, params: unknown[] = []) => db.pool.query(sql, params);

async function makeOwner(): Promise<void> {
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
const dump = async () =>
  JSON.stringify([
    (await q("select * from owner")).rows,
    (await q("select name, encode(ciphertext,'hex') c, encode(nonce,'hex') n, key_id, hint from secrets")).rows,
    (await q("select * from audit_log")).rows,
  ]);
const attempt = (code?: string) => login(db.pool, { username: "alice", password: PW, ip: "10.0.0.1", userAgent: "ua", code, now: new Date(NOW) });
const vaultCount = async () => (await q("select count(*) n from secrets where name like 'totp.%'")).rows[0].n;

describe("enroll stores only ciphertext", () => {
  it("pending_and_enabled_secret_are_never_in_any_table", async () => {
    await makeOwner();
    const { secret } = await beginTotpEnrollment(db.pool);
    expect(await dump()).not.toContain(secret);
    expect((await q("select name from secrets where name = 'totp.pending'")).rows).toHaveLength(1);
    const r = await enableTotp(db.pool, totpCode(secret, NOW), NOW);
    expect(r.ok).toBe(true);
    expect(await dump()).not.toContain(secret);
    const o = (await q("select totp_pending_secret, totp_encrypted from owner")).rows[0];
    expect(o.totp_encrypted).toBe(true);
    expect(o.totp_pending_secret).toBeNull();
    expect((await q("select name, hint from secrets")).rows).toEqual([{ name: "totp.secret", hint: "" }]);
    expect(await getSecret(db.pool, ring, "totp.secret")).toBe(secret);
  });

  it("verify_passes_through_the_vault_and_replay_is_refused", async () => {
    const { secret } = await enable();
    expect(await verifyOwnerTotp(db.pool, totpCode(secret, NOW + 30_000), NOW + 30_000)).toBe(true);
    expect(await verifyOwnerTotp(db.pool, totpCode(secret, NOW + 30_000), NOW + 30_000)).toBe(false);
  });

  it("disable_and_owner_reset_remove_the_vault_rows_and_flag", async () => {
    const { secret } = await enable();
    expect(await disableTotp(db.pool, { proof: totpCode(secret, NOW + 30_000), nowMs: NOW + 30_000 })).toBe(true);
    expect(await vaultCount()).toBe("0");
    expect((await q("select totp_encrypted from owner")).rows[0].totp_encrypted).toBe(false);
    const again = await beginTotpEnrollment(db.pool);
    expect((await enableTotp(db.pool, totpCode(again.secret, NOW), NOW)).ok).toBe(true);
    expect(await vaultCount()).toBe("1");
    await clearOwnerSecurity(db.pool);
    expect(await vaultCount()).toBe("0");
    expect((await q("select totp_secret, totp_encrypted from owner")).rows[0]).toEqual({ totp_secret: null, totp_encrypted: false });
  });
});

describe("fail closed", () => {
  it("wrong_master_key_refuses_login_with_vault_reason_and_error_has_no_secret", async () => {
    const { secret, codes } = await enable();
    setTotpKeyring(() => otherRing);
    const good = totpCode(secret, NOW + 30_000);
    expect(await attempt(good)).toEqual({ ok: false, reason: "vault" });
    expect(await attempt(codes[0])).toEqual({ ok: false, reason: "vault" }); // recovery codes are no bypass
    const e = await verifyOwnerTotp(db.pool, good, NOW + 30_000).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(String(e) + JSON.stringify(e)).not.toContain(secret);
    expect((await q("select count(*) n from sessions")).rows[0].n).toBe("0");
    expect(await dump()).not.toContain(secret);
  });

  it("missing_master_key_refuses_login_but_password_only_owner_is_unaffected", async () => {
    await enable();
    setTotpKeyring(() => {
      throw new Error("VAULT_MASTER_KEY=supersecretvalue is bad");
    });
    expect(await attempt("123456")).toEqual({ ok: false, reason: "vault" });
    const e = await verifyOwnerTotp(db.pool, "123456", NOW).catch((x: unknown) => x);
    expect(String(e)).not.toContain("supersecretvalue");
    expect((await q("select count(*) n from sessions")).rows[0].n).toBe("0");
    await clearOwnerSecurity(db.pool);
    expect((await attempt()).ok).toBe(true);
  });

  it("plaintext_in_the_secret_column_is_rejected_even_when_flag_is_set", async () => {
    const s = generateSecret();
    await enable();
    await db.ownerPool.query("update owner set totp_secret = $1, totp_encrypted = true", [s]);
    expect(await attempt(totpCode(s, NOW + 30_000))).toEqual({ ok: false, reason: "vault" });
  });

  it("unmigrated_plaintext_row_is_refused_until_backfilled_no_plaintext_fallback", async () => {
    await makeOwner();
    const s = generateSecret();
    await db.ownerPool.query("update owner set totp_secret = $1, totp_encrypted = false", [s]);
    expect(await totpEnabled(db.pool)).toBe(true);
    expect(await attempt(totpCode(s, NOW + 30_000))).toEqual({ ok: false, reason: "vault" });
  });

  it("legacy_plaintext_pending_secret_cannot_be_enabled", async () => {
    await makeOwner();
    const s = generateSecret();
    await db.ownerPool.query("update owner set totp_pending_secret = $1", [s]);
    expect((await enableTotp(db.pool, totpCode(s, NOW), NOW)).ok).toBe(false);
  });
});

describe("backfill", () => {
  it("encrypts_plaintext_secret_and_pending_idempotently_and_leaves_no_plaintext", async () => {
    await makeOwner();
    const s = generateSecret();
    const p = generateSecret();
    await db.ownerPool.query("update owner set totp_secret = $1, totp_pending_secret = $2, totp_last_step = 7, totp_encrypted = false", [s, p]);
    expect(await backfillTotpSecrets(db.ownerPool, ring)).toEqual({ secret: true, pending: true });
    const all = await dump();
    expect(all).not.toContain(s);
    expect(all).not.toContain(p);
    const before = (await q("select name, encode(ciphertext,'hex') c from secrets order by name")).rows;
    expect(await backfillTotpSecrets(db.ownerPool, ring)).toEqual({ secret: false, pending: false });
    expect((await q("select name, encode(ciphertext,'hex') c from secrets order by name")).rows).toEqual(before);
    expect(await getSecret(db.pool, ring, "totp.secret")).toBe(s);
    expect(await getSecret(db.pool, ring, "totp.pending")).toBe(p);
    expect((await q("select totp_last_step from owner")).rows[0].totp_last_step).toBe("7");
    expect((await attempt(totpCode(s, NOW + 30_000))).ok).toBe(true); // login works end to end afterwards
  });

  it("an_already_migrated_row_is_untouched_by_a_run_with_another_key", async () => {
    await makeOwner();
    const s = generateSecret();
    await db.ownerPool.query("update owner set totp_secret = $1, totp_encrypted = false", [s]);
    await backfillTotpSecrets(db.ownerPool, ring);
    expect(await backfillTotpSecrets(db.ownerPool, otherRing)).toEqual({ secret: false, pending: false });
    expect(await getSecret(db.pool, ring, "totp.secret")).toBe(s);
  });

  it("no_owner_or_no_totp_is_a_noop", async () => {
    expect(await backfillTotpSecrets(db.ownerPool, ring)).toEqual({ secret: false, pending: false });
    await makeOwner();
    expect(await backfillTotpSecrets(db.ownerPool, ring)).toEqual({ secret: false, pending: false });
  });
});
