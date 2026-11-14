import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTestDb, type TestDb } from "../support/db";
import { ENGINE_NUMBER_FIELDS } from "@/server/core/engine-numbers";
import { SETTINGS } from "@/server/core/settings-registry";
import { getSetting, setSetting } from "@/server/db/settings";
import { listAudit } from "@/server/db/audit";
import { loadEngineNumbers, loadEngineSwitch, saveEngineNumbers, saveEngineSwitch } from "@/server/db/system-settings";

let db: TestDb;
beforeAll(async () => {
  db = await withTestDb();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
});

const form = (over: Record<string, string> = {}) => ({
  ...Object.fromEntries(ENGINE_NUMBER_FIELDS.map((f) => [f.key, [SETTINGS[f.key].default].flat().join(",")])),
  ...over,
});

describe("engine numbers (app role)", () => {
  it("loads the seeded defaults", async () => {
    const v = await loadEngineNumbers(db.pool);
    for (const f of ENGINE_NUMBER_FIELDS) expect(v[f.key], f.key).toEqual(SETTINGS[f.key].default);
  });

  it("saves changes and audits only what changed", async () => {
    const r = await saveEngineNumbers(db.pool, form({ "engine.timeout_stage_s": "900", "engine.retry_backoff_seconds": "10, 20" }));
    expect(r.ok).toBe(true);
    expect(await getSetting(db.pool, "engine.timeout_stage_s")).toBe(900);
    expect(await getSetting(db.pool, "engine.retry_backoff_seconds")).toEqual([10, 20]);
    const rows = (await listAudit(db.pool, { eventPrefix: "setting.changed" })).rows;
    expect(rows.map((x) => (x.detail as { setting: string }).setting).sort()).toEqual(["engine.retry_backoff_seconds", "engine.timeout_stage_s"]);
    expect(rows.find((x) => (x.detail as { setting: string }).setting === "engine.timeout_stage_s")!.detail).toMatchObject({ from: 1800, to: 900 });
  });

  it("refuses an out-of-range value and saves nothing", async () => {
    const r = await saveEngineNumbers(db.pool, form({ "engine.timeout_stage_s": "900", "breaker.threshold": "101" }));
    expect(r.ok).toBe(false);
    expect(await getSetting(db.pool, "engine.timeout_stage_s")).toBe(1800);
  });

  it("is session-only: a token cannot write an engine number", async () => {
    await expect(setSetting(db.pool, "engine.timeout_stage_s", 900, { actor: "token" })).rejects.toThrow();
    expect(await getSetting(db.pool, "engine.timeout_stage_s")).toBe(1800);
  });
});

describe("the engine switch (engine.enabled)", () => {
  it("starts off, turns on and off as a session, and is audited", async () => {
    expect(await loadEngineSwitch(db.pool)).toBe(false);
    expect(await saveEngineSwitch(db.pool, true)).toMatchObject({ ok: true });
    expect(await getSetting(db.pool, "engine.enabled")).toBe(true);
    expect((await db.pool.query("select updated_by from settings where key = 'engine.enabled'")).rows[0].updated_by).toBe("session");
    const audit = (await listAudit(db.pool, { eventPrefix: "setting.changed" })).rows.map((x) => x.detail as { setting: string; from: unknown; to: unknown });
    expect(audit.find((d) => d.setting === "engine.enabled")).toMatchObject({ from: false, to: true });
    expect(await saveEngineSwitch(db.pool, false)).toMatchObject({ ok: true });
    expect(await loadEngineSwitch(db.pool)).toBe(false);
  });
});
