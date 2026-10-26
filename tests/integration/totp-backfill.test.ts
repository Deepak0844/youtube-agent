import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const spoof = vi.hoisted(() => ({ on: false }));
vi.mock("@/server/db/vault", async (orig) => {
  const v = await orig<typeof import("@/server/db/vault")>();
  // Read-back spoof: simulates a vault that returns something other than what was just sealed.
  return { ...v, getSecret: async (...a: Parameters<typeof v.getSecret>) => (spoof.on ? "WRONG" : v.getSecret(...a)) };
});

import { generateSecret } from "@/server/core/totp";
import { generateMasterKey, makeKeyring } from "@/server/core/vault-crypto";
import { consumeSetupLink, createSetupLink } from "@/server/db/owner";
import { backfillTotpSecrets, runTotpBackfill } from "@/server/db/totp-backfill";
import { putSecret } from "@/server/db/vault";
import { withTestDb, type TestDb } from "../support/db";

const run = promisify(execFile);
const keyB64 = generateMasterKey();
const ring = makeKeyring(keyB64);
const wrongRing = makeKeyring(generateMasterKey());
let db: TestDb;
beforeAll(async () => {
  db = await withTestDb();
});
beforeEach(async () => {
  spoof.on = false;
  await db.reset();
  const l = await createSetupLink(db.pool, "create", "http://localhost:3000");
  await consumeSetupLink(db.pool, l.slice("http://localhost:3000/setup/".length), { username: "alice", password: "correct horse battery staple" });
});
afterAll(async () => {
  await db?.stop();
});
const q = (sql: string, p: unknown[] = []) => db.ownerPool.query(sql, p);
const plain = async (s: string) => q("update owner set totp_secret = $1, totp_encrypted = false", [s]);
const stored = async () => (await q("select totp_secret, totp_encrypted from owner")).rows[0];

describe("data-loss guard", () => {
  it("refuses_when_the_key_does_not_open_existing_vault_rows_and_leaves_plaintext", async () => {
    await putSecret(db.pool, ring, "provider.openai.key", "sk-existing-value-123456");
    const s = generateSecret();
    await plain(s);
    await expect(backfillTotpSecrets(db.ownerPool, wrongRing)).rejects.toThrow(/refus/i);
    expect(await stored()).toEqual({ totp_secret: s, totp_encrypted: false });
    expect((await q("select count(*) n from secrets where name like 'totp.%'")).rows[0].n).toBe("0");
    const r = await runTotpBackfill(db.ownerPool, () => wrongRing);
    expect(r.exitCode).toBe(1);
    expect(r.message).not.toContain(s);
    expect(r.message).not.toContain(keyB64);
    expect(await stored()).toEqual({ totp_secret: s, totp_encrypted: false });
  });

  it("proceeds_when_every_existing_row_opens", async () => {
    await putSecret(db.pool, ring, "provider.openai.key", "sk-existing-value-123456");
    await plain(generateSecret());
    expect(await backfillTotpSecrets(db.ownerPool, ring)).toEqual({ secret: true, pending: false });
  });

  it("read_back_mismatch_aborts_and_rolls_back_leaving_plaintext", async () => {
    const s = generateSecret();
    await plain(s);
    spoof.on = true;
    await expect(backfillTotpSecrets(db.ownerPool, ring)).rejects.toThrow(/read-back/);
    expect(await stored()).toEqual({ totp_secret: s, totp_encrypted: false });
    expect((await q("select count(*) n from secrets where name like 'totp.%'")).rows[0].n).toBe("0");
  });
});

describe("runTotpBackfill and the db:migrate path", () => {
  it("missing_key_with_plaintext_present_exits_1_and_leaves_plaintext", async () => {
    const s = generateSecret();
    await plain(s);
    const r = await runTotpBackfill(db.ownerPool, () => {
      throw new Error(`VAULT_MASTER_KEY=${keyB64}`);
    });
    expect(r.exitCode).toBe(1);
    expect(r.message).not.toContain(keyB64);
    expect(r.message).not.toContain(s);
    expect(await stored()).toEqual({ totp_secret: s, totp_encrypted: false });
  });

  it("nothing_to_do_needs_no_key", async () => {
    const r = await runTotpBackfill(db.ownerPool, () => {
      throw new Error("no key");
    });
    expect(r.exitCode).toBe(0);
  });

  it("audit_detail_is_counts_only", async () => {
    await plain(generateSecret());
    await runTotpBackfill(db.ownerPool, () => ring);
    expect((await q("select detail from audit_log where event = 'totp.backfilled'")).rows).toEqual([{ detail: { rows: 1 } }]);
  });

  it("db_migrate_script_exits_non_zero_without_a_key_and_zero_with_one", async () => {
    const s = generateSecret();
    await plain(s);
    const base = { ...process.env, MIGRATE_DATABASE_URL: db.ownerUrl, VAULT_MASTER_KEY: "", VAULT_MASTER_KEY_PREVIOUS: "" };
    const bad = await run("npx", ["tsx", "scripts/db-migrate.ts"], { env: base }).then(
      () => ({ code: 0, err: "" }),
      (e: { code: number; stderr: string }) => ({ code: e.code, err: e.stderr }),
    );
    expect(bad.code).toBe(1);
    expect(bad.err).not.toContain(s);
    expect(await stored()).toEqual({ totp_secret: s, totp_encrypted: false });
    await run("npx", ["tsx", "scripts/db-migrate.ts"], { env: { ...base, VAULT_MASTER_KEY: keyB64 } });
    expect(await stored()).toEqual({ totp_secret: "vault:totp.secret", totp_encrypted: true });
  }, 120_000);
});
