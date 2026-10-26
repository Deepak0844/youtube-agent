import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@/server/db/migrate";
import { APP_PW, OWNER_PW, withTestDb, type TestDb } from "../support/db";
import { bootstrapRoles } from "@/server/db/bootstrap";

let db: TestDb;
beforeAll(async () => {
  db = await withTestDb();
  await db.ownerPool.query("insert into audit_log (event) values ('seed')");
});
afterAll(async () => {
  await db?.stop();
});

const app = (sql: string) => db.pool.query(sql);
const denied = { code: "42501" }; // insufficient_privilege

describe("db roles and grants", () => {
  it("harness_hands_tests_the_app_role", async () => {
    expect((await app("select current_user u")).rows[0].u).toBe("ytstudio_app");
    expect((await db.ownerPool.query("select current_user u")).rows[0].u).toBe("ytstudio_owner");
  });

  it("app_role_is_not_superuser_and_owns_nothing", async () => {
    const r = await db.ownerPool.query("select rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls from pg_roles where rolname = 'ytstudio_app'");
    expect(r.rows[0]).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
    const owned = await db.ownerPool.query(
      "select count(*)::int n from pg_class c join pg_roles r on r.oid = c.relowner where r.rolname = 'ytstudio_app'",
    );
    expect(owned.rows[0].n).toBe(0);
  });

  it("app_role_cannot_change_schema_or_roles", async () => {
    await expect(app("create table nope (id int)")).rejects.toMatchObject(denied);
    await expect(app("drop table owner")).rejects.toMatchObject({ code: "42501" });
    await expect(app("truncate sessions")).rejects.toMatchObject(denied);
    await expect(app("alter table sessions add column x int")).rejects.toMatchObject({ code: "42501" });
    await expect(app("create role evil")).rejects.toMatchObject(denied);
  });

  it("audit_log_is_insert_and_select_only_for_the_app", async () => {
    await app("insert into audit_log (event) values ('ok')");
    expect((await app("select count(*)::int n from audit_log")).rows[0].n).toBeGreaterThan(0);
    await expect(app("update audit_log set event = 'x'")).rejects.toMatchObject(denied);
    await expect(app("delete from audit_log")).rejects.toMatchObject(denied);
    await expect(app("truncate audit_log")).rejects.toMatchObject(denied);
  });

  it("schema_migrations_is_read_only_for_the_app", async () => {
    expect((await app("select count(*)::int n from schema_migrations")).rows[0].n).toBeGreaterThan(0);
    await expect(app("insert into schema_migrations (name) values ('x')")).rejects.toMatchObject(denied);
    await expect(app("update schema_migrations set name = 'x'")).rejects.toMatchObject(denied);
    await expect(app("delete from schema_migrations")).rejects.toMatchObject(denied);
    await expect(app("truncate schema_migrations")).rejects.toMatchObject(denied);
  });

  it("normal_dml_works_on_other_tables", async () => {
    await app("delete from login_attempts");
    await app("insert into login_attempts (username_key, ip, success) values ('a','i', false)");
    await app("update login_attempts set success = true");
    await app("delete from login_attempts");
  });

  it("a_table_from_a_later_migration_is_usable_by_the_app_without_new_grants", async () => {
    await db.ownerPool.query("create table later_t (id serial primary key, v text)");
    try {
      await app("insert into later_t (v) values ('a')"); // needs table INSERT and sequence USAGE
      await app("update later_t set v = 'b'");
      expect((await app("select v from later_t")).rows[0].v).toBe("b");
      await app("delete from later_t");
      await expect(app("truncate later_t")).rejects.toMatchObject(denied);
    } finally {
      await db.ownerPool.query("drop table later_t");
    }
  });

  it("owner_pool_can_migrate_again_and_bootstrap_is_idempotent", async () => {
    await migrate(db.ownerPool);
    await bootstrapRoles(db.superPool, { ownerPassword: OWNER_PW, appPassword: APP_PW });
    await bootstrapRoles(db.superPool, { ownerPassword: OWNER_PW, appPassword: APP_PW });
    expect((await app("select 1 as one")).rows[0].one).toBe(1);
    await expect(app("delete from audit_log")).rejects.toMatchObject(denied);
  });

  it("public_has_no_create_on_schema", async () => {
    const r = await db.ownerPool.query("select has_schema_privilege('public', 'public', 'CREATE') c");
    expect(r.rows[0].c).toBe(false);
  });
});
