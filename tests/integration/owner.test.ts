import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { verifyPassword } from "@/server/core/auth-crypto";
import { uuidv7 } from "@/server/core/ids";
import { audit, consumeSetupLink, createSetupLink, ownerExists, revokeAllSessions } from "@/server/db/owner";
import { runOwnerCreate, runOwnerReset } from "@/server/db/owner-cli";
import { withTestDb, type TestDb } from "../support/db";

const run = promisify(execFile);
const BASE = "http://localhost:3000";
const PW = "correct horse battery staple";
const USER = "alice";

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

const tokenOf = (link: string) => link.slice(`${BASE}/setup/`.length);
const q = (sql: string, params: unknown[] = []) => db.pool.query(sql, params);
const link = (purpose: "create" | "reset") => createSetupLink(db.pool, purpose, BASE);
async function makeOwner(): Promise<void> {
  expect(await consumeSetupLink(db.pool, tokenOf(await link("create")), { username: USER, password: PW })).toEqual({ ok: true });
}
async function seedSecurity(): Promise<void> {
  await q("update owner set totp_secret = 'SECRET', totp_last_step = 5 where id = 1");
  await q("insert into recovery_codes (id, code_hash) values ($1, 'h1'), ($2, 'h2')", [uuidv7(), uuidv7()]);
  for (let i = 0; i < 2; i++) {
    await q("insert into sessions (id, token_hash, expires_at, absolute_expires_at) values ($1, $2, now() + interval '1 hour', now() + interval '1 day')", [uuidv7(), `t${i}`]);
  }
}

describe("setup links", () => {
  it("link_has_expected_shape_and_24h_expiry", async () => {
    const l = await link("create");
    expect(l).toMatch(/^http:\/\/localhost:3000\/setup\/[A-Za-z0-9_-]{43}$/);
    const { rows } = await q("select extract(epoch from expires_at - created_at) as s, extract(epoch from expires_at - clock_timestamp()) as left from setup_links");
    expect(Math.abs(Number(rows[0].left) - 86400)).toBeLessThan(60);
  });

  it("create_twice_second_refused", async () => {
    await makeOwner();
    const second = await link("create");
    expect(await consumeSetupLink(db.pool, tokenOf(second), { username: "bob12", password: PW })).toEqual({ ok: false, reason: "invalid" });
    expect((await q("select username from owner")).rows).toEqual([{ username: USER }]);
  });

  it("link_works_once", async () => {
    const t = tokenOf(await link("create"));
    expect(await consumeSetupLink(db.pool, t, { username: USER, password: PW })).toEqual({ ok: true });
    expect(await consumeSetupLink(db.pool, t, { username: USER, password: PW })).toEqual({ ok: false, reason: "used" });
    expect(await ownerExists(db.pool)).toBe(true);
  });

  it("unknown_and_garbage_tokens_are_invalid_never_throw", async () => {
    for (const t of ["nope", "", "x".repeat(300), "A".repeat(43)]) {
      expect(await consumeSetupLink(db.pool, t, { username: USER, password: PW })).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("expired_link_refused", async () => {
    const t = tokenOf(await link("create"));
    await q("update setup_links set expires_at = clock_timestamp() - interval '1 second'");
    expect(await consumeSetupLink(db.pool, t, { username: USER, password: PW })).toEqual({ ok: false, reason: "expired" });
    expect(await ownerExists(db.pool)).toBe(false);
  });

  it("newer_link_of_same_purpose_invalidates_older_unused", async () => {
    const a = tokenOf(await link("create"));
    const b = tokenOf(await link("create"));
    expect(await consumeSetupLink(db.pool, a, { username: USER, password: PW })).toEqual({ ok: false, reason: "used" });
    expect(await consumeSetupLink(db.pool, b, { username: USER, password: PW })).toEqual({ ok: true });
  });

  it("link_of_other_purpose_is_not_invalidated", async () => {
    const c = tokenOf(await link("create"));
    await link("reset");
    expect(await consumeSetupLink(db.pool, c, { username: USER, password: PW })).toEqual({ ok: true });
  });

  it("weak_password_and_bad_username_do_not_consume", async () => {
    const t = tokenOf(await link("create"));
    expect(await consumeSetupLink(db.pool, t, { username: USER, password: "short" })).toEqual({ ok: false, reason: "weak_password" });
    expect(await consumeSetupLink(db.pool, t, { username: USER, password: "password123" })).toEqual({ ok: false, reason: "weak_password" });
    expect(await consumeSetupLink(db.pool, t, { username: USER, password: "x".repeat(5000) })).toEqual({ ok: false, reason: "weak_password" });
    expect(await consumeSetupLink(db.pool, t, { username: "a b", password: PW })).toEqual({ ok: false, reason: "bad_username" });
    expect(await consumeSetupLink(db.pool, t, { username: "аlice", password: PW })).toEqual({ ok: false, reason: "bad_username" });
    expect((await q("select used_at from setup_links")).rows[0].used_at).toBeNull();
    expect(await ownerExists(db.pool)).toBe(false);
    expect(await consumeSetupLink(db.pool, t, { username: " Alice ", password: PW })).toEqual({ ok: true });
    const o = (await q("select username, password_hash from owner")).rows[0];
    expect(o.username).toBe("alice");
    expect(await verifyPassword(PW, o.password_hash)).toBe(true);
  });

  it("twenty_concurrent_consumers_exactly_one_wins", async () => {
    const t = tokenOf(await link("create"));
    const url = db.pool.options.connectionString!;
    const pools = Array.from({ length: 20 }, () => new pg.Pool({ connectionString: url, max: 1 }));
    try {
      const res = await Promise.all(pools.map((p, i) => consumeSetupLink(p, t, { username: `user${i}`.padEnd(5, "x"), password: PW })));
      expect(res.filter((r) => r.ok)).toHaveLength(1);
      expect(res.filter((r) => !r.ok && r.reason === "used")).toHaveLength(19);
      expect((await q("select count(*)::int as n from owner")).rows[0].n).toBe(1);
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
  });

  it("concurrent_createSetupLink_leaves_exactly_one_live_link_per_purpose", async () => {
    await makeOwner();
    const url = db.pool.options.connectionString!;
    const pools = Array.from({ length: 20 }, () => new pg.Pool({ connectionString: url, max: 1 }));
    try {
      await Promise.all(pools.map((p, i) => createSetupLink(p, i % 2 ? "create" : "reset", BASE)));
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
    const { rows } = await q("select purpose, count(*)::int as n from setup_links where used_at is null group by purpose order by purpose");
    expect(rows).toEqual([{ purpose: "create", n: 1 }, { purpose: "reset", n: 1 }]);
  });

  it("expired_unused_link_does_not_block_a_new_one", async () => {
    await link("create");
    await q("update setup_links set expires_at = clock_timestamp() - interval '1 second'");
    await link("create");
    expect((await q("select count(*)::int as n from setup_links where used_at is null")).rows[0].n).toBe(1);
  });

  it("concurrent_owner_create_cli_leaves_one_live_link", async () => {
    const url = db.pool.options.connectionString!;
    const pools = Array.from({ length: 10 }, () => new pg.Pool({ connectionString: url, max: 1 }));
    try {
      const res = await Promise.all(pools.map((p) => runOwnerCreate(p, {})));
      expect(res.every((r) => r.exitCode === 0)).toBe(true);
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
    expect((await q("select count(*)::int as n from setup_links where used_at is null")).rows[0].n).toBe(1);
  });

  it("only_the_hash_is_stored", async () => {
    const t = tokenOf(await link("create"));
    const { rows } = await q("select * from setup_links");
    expect(JSON.stringify(rows)).not.toContain(t);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("reset", () => {
  it("reset_replaces_credentials_revokes_sessions_clears_totp_and_codes", async () => {
    await makeOwner();
    await seedSecurity();
    const t = tokenOf(await link("reset"));
    expect(await consumeSetupLink(db.pool, t, { username: "newowner", password: "another long passphrase" })).toEqual({ ok: true });
    const o = (await q("select * from owner")).rows[0];
    expect(o.username).toBe("newowner");
    expect(await verifyPassword("another long passphrase", o.password_hash)).toBe(true);
    expect(await verifyPassword(PW, o.password_hash)).toBe(false);
    expect(o.totp_secret).toBeNull();
    expect(o.totp_last_step).toBeNull();
    expect((await q("select count(*)::int as n from recovery_codes")).rows[0].n).toBe(0);
    expect((await q("select count(*)::int as n from sessions where revoked_at is null")).rows[0].n).toBe(0);
  });

  it("reset_link_refused_when_no_owner_and_create_link_cannot_reset", async () => {
    expect(await consumeSetupLink(db.pool, tokenOf(await link("reset")), { username: USER, password: PW })).toEqual({ ok: false, reason: "invalid" });
  });

  it("old_reset_link_refused_after_a_newer_one", async () => {
    await makeOwner();
    const old = tokenOf(await link("reset"));
    const fresh = tokenOf(await link("reset"));
    expect(await consumeSetupLink(db.pool, old, { username: USER, password: PW })).toEqual({ ok: false, reason: "used" });
    expect(await consumeSetupLink(db.pool, fresh, { username: USER, password: PW })).toEqual({ ok: true });
    expect(await consumeSetupLink(db.pool, fresh, { username: USER, password: PW })).toEqual({ ok: false, reason: "used" });
  });

  it("old_link_from_before_the_reset_refused", async () => {
    await makeOwner();
    const before = tokenOf(await link("reset"));
    const res = await runOwnerReset(db.pool, {});
    expect(res.exitCode).toBe(0);
    expect(await consumeSetupLink(db.pool, before, { username: USER, password: PW })).toEqual({ ok: false, reason: "used" });
  });

  it("twenty_concurrent_consumes_of_a_reset_link_exactly_one_wins", async () => {
    await makeOwner();
    const t = tokenOf(await link("reset"));
    const url = db.pool.options.connectionString!;
    const pools = Array.from({ length: 20 }, () => new pg.Pool({ connectionString: url, max: 1 }));
    try {
      const res = await Promise.all(pools.map((p, i) => consumeSetupLink(p, t, { username: `user${i}`.padEnd(5, "x"), password: PW })));
      expect(res.filter((r) => r.ok)).toHaveLength(1);
      expect(res.filter((r) => !r.ok && r.reason === "used")).toHaveLength(19);
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
  });

  it("consume_racing_owner_reset_never_errors_and_never_leaves_two_live_links", async () => {
    await makeOwner();
    const url = db.pool.options.connectionString!;
    const a = new pg.Pool({ connectionString: url, max: 1 });
    const b = new pg.Pool({ connectionString: url, max: 1 });
    try {
      for (let i = 0; i < 30; i++) {
        const t = tokenOf(await link("reset"));
        const [c, r] = await Promise.all([
          consumeSetupLink(a, t, { username: USER, password: PW }),
          runOwnerReset(b, {}),
        ]);
        expect(r.exitCode).toBe(0);
        if (!c.ok) expect(c.reason).toBe("used"); // superseded by the reset link
        expect((await q("select count(*)::int as n from setup_links where purpose = 'reset' and used_at is null")).rows[0].n).toBeLessThanOrEqual(1);
        // the superseded link must never be live
        expect((await q("select used_at from setup_links where token_hash = encode(sha256($1::bytea), 'hex')", [t])).rows[0].used_at).not.toBeNull();
      }
    } finally {
      await Promise.all([a.end(), b.end()]);
    }
  }, 120_000);

  it("no_deadlock_between_consume_and_reset", async () => {
    await makeOwner();
    const url = db.pool.options.connectionString!;
    const pools = Array.from({ length: 4 }, () => new pg.Pool({ connectionString: url, max: 1 }));
    try {
      for (let i = 0; i < 30; i++) {
        const t = tokenOf(await link("reset"));
        const res = await Promise.allSettled([
          consumeSetupLink(pools[0]!, t, { username: USER, password: PW }),
          runOwnerReset(pools[1]!, {}),
          runOwnerReset(pools[2]!, {}),
          consumeSetupLink(pools[3]!, t, { username: USER, password: PW }),
        ]);
        for (const r of res) expect(r.status).toBe("fulfilled");
      }
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
  }, 180_000);

  it("revokeAllSessions_is_idempotent", async () => {
    await seedSecurity();
    expect(await revokeAllSessions(db.pool)).toBe(2);
    expect(await revokeAllSessions(db.pool)).toBe(0);
  });
});

describe("audit", () => {
  it("full_flow_audit_rows_contain_no_secrets", async () => {
    const created = await runOwnerCreate(db.pool, {});
    const t1 = tokenOf(created.stdout.trim());
    await consumeSetupLink(db.pool, t1, { username: USER, password: PW });
    const reset = await runOwnerReset(db.pool, {});
    const l2 = reset.stdout.trim();
    await consumeSetupLink(db.pool, tokenOf(l2), { username: USER, password: "second long passphrase" });
    const { rows } = await q("select event, detail from audit_log order by id");
    expect(rows.map((r) => r.event)).toEqual(["owner.create_link", "owner.created", "owner.reset_link", "owner.reset_completed"]);
    const all = JSON.stringify(rows);
    for (const secret of [t1, tokenOf(l2), created.stdout.trim(), l2, PW, "second long passphrase", "scrypt$"]) expect(all).not.toContain(secret);
  });

  it("guard_rejects_secret_looking_values_outside_production", async () => {
    const tok = "A".repeat(43);
    await expect(audit(db.pool, "x", { t: tok })).rejects.toThrow(/secret/);
    await expect(audit(db.pool, "x", { nested: { arr: [`${BASE}/setup/${tok}`] } })).rejects.toThrow(/secret/);
    await expect(audit(db.pool, "x", { h: "a".repeat(64) })).rejects.toThrow(/secret/);
    expect((await q("select count(*)::int as n from audit_log")).rows[0].n).toBe(0);
    await audit(db.pool, "ok", { n: 3, s: "short", id: uuidv7() });
    expect((await q("select count(*)::int as n from audit_log")).rows[0].n).toBe(1);
  });

  it("guard_redacts_in_production", async () => {
    const prev = process.env.NODE_ENV;
    const logged: string[] = [];
    const orig = console.error;
    console.error = (m: unknown) => void logged.push(String(m));
    (process.env as Record<string, string>).NODE_ENV = "production";
    try {
      await audit(db.pool, "x", { t: "B".repeat(43), keep: "fine" });
    } finally {
      (process.env as Record<string, string>).NODE_ENV = prev!;
      console.error = orig;
    }
    expect(logged.map((l) => JSON.parse(l))).toEqual([{ event: "audit.redacted", key: "t" }]);
    expect(logged.join()).not.toContain("BBBB");
    const { rows } = await q("select detail from audit_log");
    expect(rows[0].detail).toEqual({ t: "[redacted]", keep: "fine" });
  });
});

describe("cli functions", () => {
  it("create_prints_exactly_one_link_line_exit_0", async () => {
    const r = await runOwnerCreate(db.pool, {});
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toMatch(/^http:\/\/localhost:3000\/setup\/[A-Za-z0-9_-]{43}\n$/);
    expect(r.stdout.trimEnd().split("\n")).toHaveLength(1);
  });

  it("create_honours_APP_URL_and_rejects_a_bad_one", async () => {
    const r = await runOwnerCreate(db.pool, { APP_URL: "https://studio.example.com/" });
    expect(r.stdout).toMatch(/^https:\/\/studio\.example\.com\/setup\/[A-Za-z0-9_-]{43}\n$/);
    const bad = await runOwnerCreate(db.pool, { APP_URL: "javascript:alert(1)" });
    expect(bad).toMatchObject({ exitCode: 1, stdout: "" });
  });

  it("create_with_existing_owner_exits_1_with_message_and_no_link", async () => {
    await makeOwner();
    const before = (await q("select count(*)::int as n from setup_links")).rows[0].n;
    const r = await runOwnerCreate(db.pool, {});
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/owner already exists/i);
    expect((await q("select count(*)::int as n from setup_links")).rows[0].n).toBe(before);
  });

  it("reset_with_no_owner_exits_1", async () => {
    const r = await runOwnerReset(db.pool, {});
    expect(r).toMatchObject({ exitCode: 1, stdout: "" });
    expect(r.stderr).toMatch(/no owner/i);
  });

  it("pending_reset_keeps_totp_enforced_until_link_is_consumed", async () => {
    await makeOwner();
    await seedSecurity();
    const r = await runOwnerReset(db.pool, {});
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^http:\/\/localhost:3000\/setup\/[A-Za-z0-9_-]{43}\n$/);
    expect((await q("select count(*)::int as n from sessions where revoked_at is null")).rows[0].n).toBe(0);
    expect((await q("select count(*)::int as n from recovery_codes")).rows[0].n).toBe(2);
    expect((await q("select totp_secret from owner")).rows[0].totp_secret).toBe("SECRET");
    expect(await consumeSetupLink(db.pool, tokenOf(r.stdout.trim()), { username: USER, password: PW })).toEqual({ ok: true });
    expect((await q("select count(*)::int as n from recovery_codes")).rows[0].n).toBe(0);
    expect((await q("select totp_secret from owner")).rows[0].totp_secret).toBeNull();
  });
});

describe("cli process", () => {
  it("owner_create_script_wires_up_and_exits_correctly", async () => {
    const env = { ...process.env, DATABASE_URL: db.pool.options.connectionString!, MIGRATE_DATABASE_URL: db.ownerUrl, APP_URL: "" };
    delete (env as Record<string, string | undefined>).APP_URL;
    const ok = await run("npx", ["tsx", "scripts/owner-create.ts"], { env, timeout: 90_000 });
    expect(ok.stdout).toMatch(/^http:\/\/localhost:3000\/setup\/[A-Za-z0-9_-]{43}\n$/);
    await makeOwner();
    await expect(run("npx", ["tsx", "scripts/owner-create.ts"], { env, timeout: 90_000 })).rejects.toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.stringMatching(/owner already exists/i),
    });
    const noDb = { ...process.env };
    delete (noDb as Record<string, string | undefined>).MIGRATE_DATABASE_URL;
    await expect(run("npx", ["tsx", "scripts/owner-create.ts"], { env: noDb, timeout: 90_000 })).rejects.toMatchObject({ code: 1, stderr: expect.stringMatching(/MIGRATE_DATABASE_URL/) });
  }, 240_000);
});
