import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeKeyring, VaultError } from "@/server/core/vault-crypto";
import { loadKeyring } from "@/server/db/master-key";
import { deleteSecret, getSecret, hasSecret, listSecrets, putSecret, rewrapAll, vaultStatus } from "@/server/db/vault";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
const key = () => randomBytes(32).toString("base64");
const K1 = key();
const ring = makeKeyring(K1);
const PLAIN = "sk-ant-api03-SUPERSECRETVALUE-1234";

beforeAll(async () => {
  db = await withTestDb();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.ownerPool.query("truncate secrets");
});
afterEach(() => vi.restoreAllMocks());

describe("vault db", () => {
  it("app_role_round_trips_and_replaces", async () => {
    await putSecret(db.pool, ring, "provider.a.key", PLAIN);
    expect(await getSecret(db.pool, ring, "provider.a.key")).toBe(PLAIN);
    await putSecret(db.pool, ring, "provider.a.key", "second-value-0000000");
    expect(await getSecret(db.pool, ring, "provider.a.key")).toBe("second-value-0000000");
    expect(await hasSecret(db.pool, "provider.a.key")).toBe(true);
    expect(await hasSecret(db.pool, "nope")).toBe(false);
    await deleteSecret(db.pool, "provider.a.key");
    expect(await hasSecret(db.pool, "provider.a.key")).toBe(false);
  });

  it("missing_secret_is_an_error_not_an_empty_string", async () => {
    await expect(getSecret(db.pool, ring, "absent")).rejects.toMatchObject({ code: "not_found" });
  });

  it("db_dump_contains_no_plaintext", async () => {
    await putSecret(db.pool, ring, "provider.a.key", PLAIN);
    const dump = await db.ownerPool.query("select * from secrets");
    const blob = JSON.stringify(dump.rows) + dump.rows.map((r) => Buffer.concat([r.ciphertext, r.nonce]).toString("latin1")).join("");
    expect(blob).not.toContain(PLAIN);
    expect(blob).not.toContain("SUPERSECRET");
    expect(blob).not.toContain(K1);
    const text = await db.ownerPool.query("select t::text s from secrets t");
    expect(text.rows[0].s).not.toContain("SUPERSECRET");
  });

  it("listing_returns_only_masked_tail_never_decrypts", async () => {
    await putSecret(db.pool, ring, "provider.a.key", PLAIN);
    await putSecret(db.pool, ring, "provider.b.key", "short");
    const rows = await listSecrets(db.pool); // takes no keyring: it cannot decrypt
    expect(listSecrets.length).toBe(1);
    expect(rows.map((r) => [r.name, r.hint])).toEqual([
      ["provider.a.key", "1234"],
      ["provider.b.key", ""],
    ]);
    expect(JSON.stringify(rows)).not.toContain("SUPERSECRET");
    expect(Object.keys(rows[0]!).sort()).toEqual(["hint", "keyId", "name", "updatedAt"]);
  });

  it("same_value_written_twice_stores_different_bytes", async () => {
    await putSecret(db.pool, ring, "a", PLAIN);
    const a = (await db.ownerPool.query("select ciphertext, nonce from secrets where name = 'a'")).rows[0];
    await putSecret(db.pool, ring, "a", PLAIN);
    const b = (await db.ownerPool.query("select ciphertext, nonce from secrets where name = 'a'")).rows[0];
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it("row_tamper_in_db_fails_closed", async () => {
    await putSecret(db.pool, ring, "a", PLAIN);
    await db.ownerPool.query("update secrets set ciphertext = set_byte(ciphertext, 0, get_byte(ciphertext, 0) # 1) where name = 'a'");
    await expect(getSecret(db.pool, ring, "a")).rejects.toBeInstanceOf(VaultError);
  });

  it("ciphertext_swapped_between_names_in_db_fails", async () => {
    await putSecret(db.pool, ring, "a", PLAIN);
    await putSecret(db.pool, ring, "b", "another-value-000000");
    await db.ownerPool.query(
      "update secrets t set ciphertext = s.ciphertext, nonce = s.nonce, key_id = s.key_id from secrets s where t.name = 'b' and s.name = 'a'",
    );
    await expect(getSecret(db.pool, ring, "b")).rejects.toBeInstanceOf(VaultError);
    expect(await getSecret(db.pool, ring, "a")).toBe(PLAIN);
  });

  it("wrong_master_key_fails_closed_with_wrong_key_status", async () => {
    await putSecret(db.pool, ring, "a", PLAIN);
    const other = makeKeyring(key());
    await expect(getSecret(db.pool, other, "a")).rejects.toMatchObject({ code: "wrong_key" });
    expect(await vaultStatus(db.pool, other)).toEqual({ status: "wrong_key", unreadable: ["a"] });
    expect(await vaultStatus(db.pool, ring)).toEqual({ status: "ok", unreadable: [] });
  });

  it("tampered_row_reported_unreadable_by_status", async () => {
    await putSecret(db.pool, ring, "a", PLAIN);
    await putSecret(db.pool, ring, "b", PLAIN);
    await db.ownerPool.query("update secrets set nonce = decode('000000000000000000000000','hex') where name = 'b'");
    expect(await vaultStatus(db.pool, ring)).toEqual({ status: "unreadable", unreadable: ["b"] });
  });

  it("rotation_rewraps_rows_to_the_new_key_then_old_key_can_go", async () => {
    const K2 = key();
    await putSecret(db.pool, ring, "a", PLAIN);
    await putSecret(db.pool, ring, "b", "another-value-000000");
    const rotating = makeKeyring(K2, K1);
    expect(await getSecret(db.pool, rotating, "a")).toBe(PLAIN); // old row readable during the window
    expect(await rewrapAll(db.pool, rotating)).toEqual({ rewrapped: 2, unreadable: [] });
    expect(await rewrapAll(db.pool, rotating)).toEqual({ rewrapped: 0, unreadable: [] }); // idempotent
    const after = makeKeyring(K2); // old key dropped
    expect(await getSecret(db.pool, after, "a")).toBe(PLAIN);
    expect(await getSecret(db.pool, after, "b")).toBe("another-value-000000");
    expect((await db.ownerPool.query("select distinct key_id from secrets")).rows).toEqual([{ key_id: rotating.current.id }]);
  });

  it("rewrap_names_unreadable_rows_and_still_rewraps_the_rest", async () => {
    const K2 = key();
    await putSecret(db.pool, ring, "a", PLAIN);
    await putSecret(db.pool, ring, "b", PLAIN);
    await putSecret(db.pool, makeKeyring(key()), "c", PLAIN); // sealed by a key we do not have
    await db.ownerPool.query("update secrets set nonce = decode('000000000000000000000000','hex') where name = 'b'");
    const r = await rewrapAll(db.pool, makeKeyring(K2, K1));
    expect(r).toEqual({ rewrapped: 1, unreadable: ["b", "c"] });
  });

  it("rewrap_does_not_overwrite_a_value_written_concurrently", async () => {
    const K2 = key();
    await putSecret(db.pool, ring, "a", PLAIN);
    const rotating = makeKeyring(K2, K1);
    let fired = false;
    const racing = {
      async query(sql: string, params?: unknown[]) {
        const res = await db.pool.query(sql, params);
        if (!fired && sql.trimStart().startsWith("select")) {
          fired = true;
          await putSecret(db.pool, rotating, "a", "newer-value-written-concurrently");
        }
        return res;
      },
    } as unknown as Pick<import("pg").Pool, "query">;
    expect((await rewrapAll(racing, rotating)).rewrapped).toBe(0);
    expect(await getSecret(db.pool, rotating, "a")).toBe("newer-value-written-concurrently");
  });

  it("hint_rules_short_totp_owner_and_opt_out", async () => {
    const long = "x".repeat(30) + "WXYZ";
    await putSecret(db.pool, ring, "provider.a.key", long);
    await putSecret(db.pool, ring, "provider.b.key", long, { hint: false });
    await putSecret(db.pool, ring, "totp.owner", long);
    await putSecret(db.pool, ring, "owner.recovery", long);
    await putSecret(db.pool, ring, "provider.c.key", "y".repeat(22) + "Q");
    const h = Object.fromEntries((await listSecrets(db.pool)).map((r) => [r.name, r.hint]));
    expect(h).toEqual({ "provider.a.key": "WXYZ", "provider.b.key": "", "totp.owner": "", "owner.recovery": "", "provider.c.key": "" });
  });

  it("status_is_missing_key_when_the_keyring_cannot_load", async () => {
    await putSecret(db.pool, ring, "a", PLAIN);
    const loader = () => loadKeyring({});
    expect(await vaultStatus(db.pool, loader)).toEqual({ status: "missing_key", unreadable: [] });
    expect(await vaultStatus(db.pool, () => ring)).toEqual({ status: "ok", unreadable: [] });
  });

  it("errors_and_logs_never_contain_plaintext", async () => {
    const spies = (["log", "error", "warn", "info"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    await putSecret(db.pool, ring, "a", PLAIN);
    const errs: unknown[] = [];
    for (const f of [() => getSecret(db.pool, makeKeyring(key()), "a"), () => getSecret(db.pool, ring, "missing"), () => putSecret(db.pool, ring, "BAD NAME", PLAIN)]) {
      try {
        await f();
      } catch (e) {
        errs.push(e);
        console.error(e);
      }
    }
    expect(errs).toHaveLength(3);
    const blob = JSON.stringify([errs.map((e) => [String(e), (e as Error).stack]), spies.map((s) => s.mock.calls.map(String))]);
    expect(blob).not.toContain("SUPERSECRET");
    expect(blob).not.toContain(K1);
  });

  it("audit_log_is_untouched_by_vault_operations", async () => {
    const before = (await db.ownerPool.query("select count(*)::int n from audit_log")).rows[0].n;
    await putSecret(db.pool, ring, "a", PLAIN);
    await getSecret(db.pool, ring, "a");
    expect((await db.ownerPool.query("select count(*)::int n from audit_log")).rows[0].n).toBe(before);
  });

  it("app_role_cannot_truncate_or_ddl_secrets", async () => {
    await expect(db.pool.query("truncate secrets")).rejects.toMatchObject({ code: "42501" });
    await expect(db.pool.query("alter table secrets add column x int")).rejects.toMatchObject({ code: "42501" });
  });

  it("db_rejects_malformed_rows", async () => {
    await expect(db.ownerPool.query("insert into secrets (name, ciphertext, nonce, key_id) values ('x', '\\x00'::bytea, '\\x00'::bytea, 'zz')")).rejects.toBeTruthy();
  });
});

describe("loadKeyring", () => {
  it("reads_env_and_fails_explicitly_when_missing", () => {
    expect(loadKeyring({ VAULT_MASTER_KEY: K1 }).current.id).toBe(ring.current.id);
    expect(() => loadKeyring({})).toThrow(/missing or malformed/);
    expect(() => loadKeyring({ VAULT_MASTER_KEY: ` ${K1}` })).toThrow(VaultError);
    expect(() => loadKeyring({ VAULT_MASTER_KEY: "short" })).toThrow(VaultError);
    expect(loadKeyring({ VAULT_MASTER_KEY: key(), VAULT_MASTER_KEY_PREVIOUS: K1 }).byId.has(ring.current.id)).toBe(true);
  });
});
