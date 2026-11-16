import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapRoles } from "@/server/db/bootstrap";
import { createPool } from "@/server/db/pool";
import { APP_PW, OWNER_PW, withTestDb, type TestDb } from "../support/db";

// The optional ytstudio_backup role (compose): read everything, write nothing. It exists so the backup job does not need the owner
// URL, and it must NOT loosen what the app role may do (the approvals sequence stays locked to it: migration 0013).
let db: TestDb;
let backup: ReturnType<typeof createPool>;
const BACKUP_PW = "test-backup-pw";
const denied = { code: "42501" };

beforeAll(async () => {
  db = await withTestDb();
  await db.ownerPool.query("insert into audit_log (event) values ('seed')");
});
afterAll(async () => {
  await backup?.end().catch(() => {});
  await db?.stop();
});

const roleExists = async () => (await db.ownerPool.query("select 1 from pg_roles where rolname = 'ytstudio_backup'")).rowCount === 1;

describe("ytstudio_backup role", () => {
  it("is not created unless a backup password is given", async () => {
    expect(await roleExists()).toBe(false);
    await bootstrapRoles(db.superPool, { ownerPassword: OWNER_PW, appPassword: APP_PW });
    expect(await roleExists()).toBe(false);
  });

  it("is created with a password, as a plain login role with no extra powers", async () => {
    await bootstrapRoles(db.superPool, { ownerPassword: OWNER_PW, appPassword: APP_PW, backupPassword: BACKUP_PW });
    expect(await roleExists()).toBe(true);
    const r = await db.ownerPool.query("select rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin from pg_roles where rolname = 'ytstudio_backup'");
    expect(r.rows[0]).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false, rolcanlogin: true });
    const u = new URL(db.ownerUrl);
    u.username = "ytstudio_backup";
    u.password = BACKUP_PW;
    backup = createPool(u.toString());
    expect((await backup.query("select current_user u")).rows[0].u).toBe("ytstudio_backup");
  });

  it("can read everything a dump needs, including the sequence the app role is locked out of", async () => {
    await backup.query("select last_value from approvals_seq_seq");
    expect((await backup.query("select count(*)::int n from audit_log")).rows[0].n).toBeGreaterThan(0);
    await backup.query("select 1 from secrets limit 1");
  });

  it("can write nothing", async () => {
    await expect(backup.query("insert into audit_log (event) values ('x')")).rejects.toMatchObject(denied);
    await expect(backup.query("update sessions set id = id")).rejects.toMatchObject(denied);
    await expect(backup.query("delete from login_attempts")).rejects.toMatchObject(denied);
    await expect(backup.query("create table nope (id int)")).rejects.toMatchObject(denied);
    await expect(backup.query("select nextval('approvals_seq_seq')")).rejects.toMatchObject(denied);
  });

  it("does not change what the app role may do: still no right on the approvals sequence", async () => {
    await expect(db.pool.query("select last_value from approvals_seq_seq")).rejects.toMatchObject(denied);
  });

  it("re-running bootstrap rotates the backup password", async () => {
    await bootstrapRoles(db.superPool, { ownerPassword: OWNER_PW, appPassword: APP_PW, backupPassword: "rotated-pw" });
    const u = new URL(db.ownerUrl);
    u.username = "ytstudio_backup";
    u.password = "rotated-pw";
    const again = createPool(u.toString());
    try {
      expect((await again.query("select 1 as ok")).rows[0].ok).toBe(1);
    } finally {
      await again.end();
    }
  });
});
