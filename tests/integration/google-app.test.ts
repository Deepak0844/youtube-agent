import type pg from "pg";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeKeyring } from "@/server/core/vault-crypto";
import { SECRET_NAME } from "@/server/core/google-app";
import { getSecret } from "@/server/db/vault";
import { getOwnGoogleApp, saveOwnGoogleApp, testOwnGoogleApp, listLegacyGoogleApps } from "@/server/db/google-app";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
const ring = makeKeyring(randomBytes(32).toString("base64"));
const otherRing = makeKeyring(randomBytes(32).toString("base64"));
const ID = "123456789012-abcdefghijklmnopqrstuv12.apps.googleusercontent.com";
const ID2 = "999999999999-zzzzzzzzzzzzzzzzzzzzzzzz.apps.googleusercontent.com";
const SECRET = "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1";
const SECRET2 = "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";

beforeAll(async () => {
  db = await withTestDb();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.ownerPool.query("truncate google_apps, secrets, audit_log");
});

describe("google app (app role)", () => {
  it("stores the secret through the vault only, never in google_apps", async () => {
    const r = await saveOwnGoogleApp(db.pool, ring, { clientId: ID, clientSecret: SECRET });
    expect(r).toEqual({ ok: true });
    expect(await getSecret(db.pool, ring, SECRET_NAME)).toBe(SECRET);
    const row = await db.ownerPool.query("select * from google_apps");
    expect(JSON.stringify(row.rows)).not.toContain(SECRET);
    expect(row.rows[0].client_secret_name).toBe(SECRET_NAME);
    const sec = await db.ownerPool.query("select ciphertext, hint from secrets where name = $1", [SECRET_NAME]);
    expect(Buffer.from(sec.rows[0].ciphertext).includes(Buffer.from(SECRET))).toBe(false);
    expect(sec.rows[0].hint).toBe("0001");
  });

  it("view has masked hint, never the secret", async () => {
    await saveOwnGoogleApp(db.pool, ring, { clientId: ID, clientSecret: SECRET });
    const v = await getOwnGoogleApp(db.pool);
    expect(v).toMatchObject({ clientId: ID, secretStored: true, secretHint: "0001" });
    expect(JSON.stringify(v)).not.toContain(SECRET);
  });

  it("short secret gets no hint", async () => {
    await saveOwnGoogleApp(db.pool, ring, { clientId: ID, clientSecret: "shortsecret1" });
    expect((await getOwnGoogleApp(db.pool))!.secretHint).toBe("");
  });

  it("saving twice replaces: one row, new secret, id kept when blank", async () => {
    await saveOwnGoogleApp(db.pool, ring, { clientId: ID, clientSecret: SECRET });
    await saveOwnGoogleApp(db.pool, ring, { clientSecret: SECRET2 });
    await saveOwnGoogleApp(db.pool, ring, { clientId: ID2 });
    expect((await db.ownerPool.query("select count(*)::int n from google_apps")).rows[0].n).toBe(1);
    expect(await getSecret(db.pool, ring, SECRET_NAME)).toBe(SECRET2);
    expect((await getOwnGoogleApp(db.pool))!.clientId).toBe(ID2);
  });

  it("refuses to save when the vault key does not open existing entries (fail closed)", async () => {
    await saveOwnGoogleApp(db.pool, ring, { clientId: ID, clientSecret: SECRET });
    const r = await saveOwnGoogleApp(db.pool, otherRing, { clientSecret: SECRET2 });
    expect(r).toEqual({ ok: false, reason: "vault" });
    expect(await getSecret(db.pool, ring, SECRET_NAME)).toBe(SECRET);
  });

  it("refuses a first save with no secret, and bad shapes", async () => {
    expect(await saveOwnGoogleApp(db.pool, ring, { clientId: ID })).toMatchObject({ ok: false, reason: "invalid" });
    expect(await saveOwnGoogleApp(db.pool, ring, { clientId: "nope", clientSecret: SECRET })).toMatchObject({ ok: false, reason: "invalid" });
    expect(await getOwnGoogleApp(db.pool)).toBeNull();
  });

  it("audits google_app.saved with no values, and the secret is in no audit row or log", async () => {
    const logs: string[] = [];
    for (const m of ["log", "error", "warn", "info"] as const) vi.spyOn(console, m).mockImplementation((...a) => void logs.push(a.map(String).join(" ")));
    await saveOwnGoogleApp(db.pool, ring, { clientId: ID, clientSecret: SECRET });
    await saveOwnGoogleApp(db.pool, ring, { clientSecret: SECRET2 });
    vi.restoreAllMocks();
    const a = await db.ownerPool.query("select event, detail from audit_log order by id");
    expect(a.rows.map((r) => r.event)).toEqual(["google_app.saved", "google_app.saved"]);
    const dump = JSON.stringify(a.rows) + logs.join("\n");
    for (const s of [SECRET, SECRET2, ID, "SuperSecretValue"]) expect(dump).not.toContain(s);
    expect(a.rows[0].detail.changed).toEqual(["client_id", "client_secret"]);
    expect(a.rows[1].detail.changed).toEqual(["client_secret"]);
  });

  it("a failed audit rolls the whole save back", async () => {
    const failAudit = (c: pg.PoolClient): pg.PoolClient =>
      new Proxy(c, {
        get: (t, k) =>
          k === "query"
            ? (sql: unknown, ...rest: unknown[]) =>
                typeof sql === "string" && sql.includes("audit_log") ? Promise.reject(new Error("boom")) : (t.query as (...a: unknown[]) => unknown)(sql, ...rest)
            : Reflect.get(t, k) instanceof Function ? (Reflect.get(t, k) as (...a: unknown[]) => unknown).bind(t) : Reflect.get(t, k),
      });
    const bad = new Proxy(db.pool, {
      get: (t, k) => (k === "connect" ? async () => failAudit(await t.connect()) : (Reflect.get(t, k) as unknown instanceof Function ? (Reflect.get(t, k) as (...a: unknown[]) => unknown).bind(t) : Reflect.get(t, k))),
    });
    await expect(saveOwnGoogleApp(bad, ring, { clientId: ID, clientSecret: SECRET })).rejects.toThrow("boom");
    expect(await getOwnGoogleApp(db.pool)).toBeNull();
    expect((await db.ownerPool.query("select count(*)::int n from secrets")).rows[0].n).toBe(0);
  });

  it("test is format only and reports booleans", async () => {
    expect(await testOwnGoogleApp(db.pool, ring, "https://a.example.com")).toMatchObject({ clientId: false, secret: false });
    await saveOwnGoogleApp(db.pool, ring, { clientId: ID, clientSecret: SECRET });
    const t = await testOwnGoogleApp(db.pool, ring, "https://a.example.com");
    expect(t).toEqual({ clientId: true, secret: true, redirectUri: true });
    expect(JSON.stringify(t)).not.toContain(SECRET);
    expect((await testOwnGoogleApp(db.pool, ring, "http://evil.example.com")).redirectUri).toBe(false);
    expect((await testOwnGoogleApp(db.pool, otherRing, "https://a.example.com")).secret).toBe(false);
  });

  it("only one own row; legacy rows are listed read-only", async () => {
    await saveOwnGoogleApp(db.pool, ring, { clientId: ID, clientSecret: SECRET });
    await expect(db.ownerPool.query("insert into google_apps (kind, client_id, client_secret_name) values ('own', 'x', 'google.other')")).rejects.toThrow();
    await db.ownerPool.query("insert into google_apps (kind, client_id, client_secret_name) values ('legacy', $1, 'google.legacy.client_secret')", [ID2]);
    expect((await listLegacyGoogleApps(db.pool)).map((l) => l.clientId)).toEqual([ID2]);
    expect((await getOwnGoogleApp(db.pool))!.clientId).toBe(ID);
  });

  it("app role cannot alter the table", async () => {
    await expect(db.pool.query("alter table google_apps add column x int")).rejects.toThrow();
  });
});
