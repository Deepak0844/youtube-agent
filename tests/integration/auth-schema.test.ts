import { readdirSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "@/server/db/migrate";
import { uuidv7 } from "@/server/core/ids";
import { withTestDb, type TestDb } from "../support/db";

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

const insertOwner = (id?: number) =>
  db.pool.query(
    id === undefined
      ? "insert into owner (username, password_hash) values ('o','h')"
      : "insert into owner (id, username, password_hash) values ($1,'o','h')",
    id === undefined ? [] : [id],
  );

describe("auth schema", () => {
  it("owner_is_single_row", async () => {
    await insertOwner();
    await expect(insertOwner()).rejects.toMatchObject({ code: "23505" });
    await expect(insertOwner(2)).rejects.toMatchObject({ code: "23514" });
    const { rows } = await db.pool.query("select id, totp_secret, totp_last_step from owner");
    expect(rows).toEqual([{ id: 1, totp_secret: null, totp_last_step: null }]);
  });

  it("setup_link_purpose_is_checked", async () => {
    const ins = (purpose: string) =>
      db.pool.query("insert into setup_links (id, token_hash, purpose, expires_at) values ($1,$2,$3, now() + interval '1 day')", [uuidv7(), uuidv7(), purpose]);
    await ins("create");
    await ins("reset");
    await expect(ins("admin")).rejects.toMatchObject({ code: "23514" });
  });

  it("token_and_code_hashes_are_unique", async () => {
    const link = () => db.pool.query("insert into setup_links (id, token_hash, purpose, expires_at) values ($1,'t','create', now())", [uuidv7()]);
    await link();
    await expect(link()).rejects.toMatchObject({ code: "23505" });
    const code = () => db.pool.query("insert into recovery_codes (id, code_hash) values ($1,'c')", [uuidv7()]);
    await code();
    await expect(code()).rejects.toMatchObject({ code: "23505" });
    const sess = () =>
      db.pool.query("insert into sessions (id, token_hash, expires_at, absolute_expires_at) values ($1,'s', now(), now())", [uuidv7()]);
    await sess();
    await expect(sess()).rejects.toMatchObject({ code: "23505" });
  });

  it("attempt_and_audit_ids_are_generated_and_defaults_apply", async () => {
    await db.pool.query("insert into login_attempts (username_key, ip, success) values ('u','1.2.3.4', false)");
    await db.pool.query("insert into audit_log (event, detail) values ('x', '{\"a\":1}')");
    const a = await db.pool.query("select id, at from login_attempts");
    const b = await db.pool.query("select id, at from audit_log");
    expect(Number(a.rows[0].id)).toBe(1);
    expect(a.rows[0].at).toBeInstanceOf(Date);
    expect(Number(b.rows[0].id)).toBe(1);
  });

  it("lookup_indexes_exist", async () => {
    const { rows } = await db.pool.query<{ indexdef: string }>("select indexdef from pg_indexes where schemaname='public'");
    const defs = rows.map((r) => r.indexdef);
    const has = (table: string, cols: string) => defs.some((d) => d.includes(`ON public.${table} `) && d.includes(`(${cols})`));
    expect(has("login_attempts", "username_key, at")).toBe(true);
    expect(has("login_attempts", "ip, at")).toBe(true);
    expect(has("sessions", "token_hash")).toBe(true);
    expect(has("setup_links", "token_hash")).toBe(true);
    expect(has("recovery_codes", "code_hash")).toBe(true);
  });

  it("migrate_is_idempotent_with_all_files", async () => {
    const files = readdirSync("src/server/db/migrations").filter((f) => f.endsWith(".sql")).sort();
    await Promise.all([migrate(db.ownerPool), migrate(db.ownerPool)]);
    const { rows } = await db.pool.query<{ name: string }>("select name from schema_migrations order by name");
    expect(rows.map((r) => r.name)).toEqual(files);
    expect(files).toContain("0001_owner_auth.sql");
  });

  it("reset_truncates_the_auth_tables", async () => {
    await insertOwner();
    await db.pool.query("insert into audit_log (event) values ('e')");
    await db.pool.query("insert into login_attempts (username_key, ip, success) values ('u','i',true)");
    await db.pool.query("insert into recovery_codes (id, code_hash) values ($1,'c')", [uuidv7()]);
    await db.pool.query("insert into setup_links (id, token_hash, purpose, expires_at) values ($1,'t','create', now())", [uuidv7()]);
    await db.pool.query("insert into sessions (id, token_hash, expires_at, absolute_expires_at) values ($1,'s', now(), now())", [uuidv7()]);
    await db.reset();
    for (const t of ["owner", "sessions", "setup_links", "recovery_codes", "login_attempts", "audit_log"]) {
      const { rows } = await db.pool.query(`select count(*)::int as n from ${t}`);
      expect(rows[0].n, t).toBe(0);
    }
    await db.pool.query("insert into audit_log (event) values ('e')");
    expect(Number((await db.pool.query("select id from audit_log")).rows[0].id)).toBe(1);
  });
});
