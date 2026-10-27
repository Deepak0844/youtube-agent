import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { withTestDb, type TestDb } from "../support/db";
import { BUDGET_DEFAULTS, SETTINGS, SAFETY_KEYS } from "@/server/core/settings-registry";
import { getSetting, setSetting } from "@/server/db/settings";

let db: TestDb;
beforeAll(async () => {
  db = await withTestDb();
});
afterAll(async () => {
  await db?.stop();
});

const reseed = async () => db.ownerPool.query(await readFile("src/server/db/migrations/0005_settings.sql", "utf8"));

describe("settings table and seed", () => {
  it("seeds_every_registry_default", async () => {
    for (const [key, def] of Object.entries(SETTINGS)) {
      expect(await getSetting(db.pool, key), key).toEqual(def.default);
    }
    const n = await db.pool.query("select count(*)::int n from settings");
    expect(n.rows[0].n).toBe(Object.keys(SETTINGS).length);
  });

  it("seeds_budget_caps_equal_doc_values", async () => {
    const r = await db.pool.query("select scope, cap_micro_usd::text c from budgets");
    expect(Object.fromEntries(r.rows.map((x) => [x.scope, Number(x.c)]))).toEqual({ ...BUDGET_DEFAULTS, llm_test: 500_000, eval: 2_000_000 }); // the last two come from migration 0018
  });

  it("reseed_is_idempotent_and_keeps_owner_edits", async () => {
    await setSetting(db.pool, "storage.warn_gb", 80, { actor: "session" });
    await db.ownerPool.query("update budgets set cap_micro_usd = 1 where scope = 'day'");
    await reseed();
    expect(await getSetting(db.pool, "storage.warn_gb")).toBe(80);
    expect((await db.pool.query("select cap_micro_usd::text c from budgets where scope='day'")).rows[0].c).toBe("1");
  });

  it("set_returns_old_and_new_and_stamps_actor", async () => {
    const r = await setSetting(db.pool, "jobs.concurrent_jobs", 3, { actor: "token" });
    expect(r).toEqual({ old: 2, new: 3 });
    const row = await db.pool.query("select updated_by, updated_at from settings where key='jobs.concurrent_jobs'");
    expect(row.rows[0].updated_by).toBe("token");
    expect(row.rows[0].updated_at).toBeInstanceOf(Date);
  });

  it("refuses_unknown_and_invalid", async () => {
    await expect(setSetting(db.pool, "nope", 1, { actor: "session" })).rejects.toThrow(/unknown setting/);
    await expect(setSetting(db.pool, "storage.warn_gb", 0, { actor: "session" })).rejects.toThrow();
    await expect(getSetting(db.pool, "nope")).rejects.toThrow(/unknown setting/);
  });

  it("only_a_session_may_write_safety_keys", async () => {
    for (const key of SAFETY_KEYS) {
      for (const actor of ["token", "system"] as const) {
        await expect(setSetting(db.pool, key, SETTINGS[key].default, { actor }), `${key}/${actor}`).rejects.toThrow(/session/);
      }
    }
    const r = await setSetting(db.pool, "policy.allow_public", true, { actor: "session" });
    expect(r).toEqual({ old: false, new: true });
  });
});
