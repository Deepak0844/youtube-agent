import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTestDb, type TestDb } from "../support/db";
import { getSetting } from "@/server/db/settings";
import { listAudit } from "@/server/db/audit";
import { loadLocalServices, saveLocalServices, saveSystemSettings } from "@/server/db/system-settings";
import { getSystemStatus } from "@/server/db/system-status";

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

const OWN = new Set([5432, 6379]);
const audit = async () => (await listAudit(db.pool, { eventPrefix: "setting.changed" })).rows;

describe("local service list (app role)", () => {
  it("saves a valid list, normalised, and audits old and new", async () => {
    const r = await saveLocalServices(db.pool, "localhost:11434\nLOCALHOST:11434\n127.0.0.1:1234", { ownPorts: OWN });
    expect(r).toEqual({ ok: true, changed: true });
    expect(await getSetting(db.pool, "network.local_services")).toEqual(["localhost:11434", "127.0.0.1:1234"]);
    expect(await loadLocalServices(db.pool)).toEqual(["localhost:11434", "127.0.0.1:1234"]);
    const [row] = await audit();
    expect(row!.detail).toMatchObject({ setting: "network.local_services", from: [], to: ["localhost:11434", "127.0.0.1:1234"] });
  });

  it("removal is audited too", async () => {
    await saveLocalServices(db.pool, "localhost:11434\n127.0.0.1:1234", { ownPorts: OWN });
    await saveLocalServices(db.pool, "localhost:11434", { ownPorts: OWN });
    const rows = await audit();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.detail).toMatchObject({ from: ["localhost:11434", "127.0.0.1:1234"], to: ["localhost:11434"] });
  });

  it("an unchanged save writes nothing and audits nothing", async () => {
    await saveLocalServices(db.pool, "localhost:11434", { ownPorts: OWN });
    const r = await saveLocalServices(db.pool, "LOCALHOST:11434\n", { ownPorts: OWN });
    expect(r).toEqual({ ok: true, changed: false });
    expect(await audit()).toHaveLength(1);
  });

  it.each(["0.0.0.0:11434", "[::]:80", "127.0.0.1:5432", "localhost:6379", "169.254.169.254:80", "2130706433:80", "0x7f000001:80", "[::ffff:127.0.0.1]:80", "user@localhost:80", "*:80", "localhost.:80"])(
    "refuses %s and leaves the stored list and audit log untouched",
    async (bad) => {
      await saveLocalServices(db.pool, "localhost:11434", { ownPorts: OWN });
      const r = await saveLocalServices(db.pool, `localhost:1234\n${bad}`, { ownPorts: OWN });
      expect(r.ok).toBe(false);
      expect(await getSetting(db.pool, "network.local_services")).toEqual(["localhost:11434"]);
      expect(await audit()).toHaveLength(1);
    },
  );

  it("a token or system actor cannot write the list", async () => {
    for (const actor of ["token", "system"] as const) {
      const r = await saveLocalServices(db.pool, "localhost:11434", { ownPorts: OWN, actor });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).not.toMatch(/session|setting|network/i); // generic
    }
    expect(await getSetting(db.pool, "network.local_services")).toEqual([]);
    expect(await audit()).toHaveLength(0);
  });

  it("the cap on entries is enforced", async () => {
    const many = Array.from({ length: 21 }, (_, i) => `localhost:${20000 + i}`).join("\n");
    expect((await saveLocalServices(db.pool, many, { ownPorts: OWN })).ok).toBe(false);
  });

  it("loadLocalServices drops anything invalid that was written behind the form's back", async () => {
    await db.ownerPool.query(`insert into settings (key, value, updated_by) values ('network.local_services', '["localhost:11434","0.0.0.0:80","*:1",5]'::jsonb, 'system')
       on conflict (key) do update set value = excluded.value`);
    expect(await loadLocalServices(db.pool, OWN)).toEqual(["localhost:11434"]);
  });
});

describe("system settings form (app role)", () => {
  const good = { concurrent_renders: 2, concurrent_jobs: 3, storage_warn_gb: 80, max_long_minutes: 20, scene_kit: false };

  it("saves each changed value and audits each", async () => {
    const r = await saveSystemSettings(db.pool, good);
    expect(r).toMatchObject({ ok: true });
    expect(await getSetting(db.pool, "jobs.concurrent_renders")).toBe(2);
    expect(await getSetting(db.pool, "jobs.concurrent_jobs")).toBe(3);
    expect(await getSetting(db.pool, "storage.warn_gb")).toBe(80);
    expect(await getSetting(db.pool, "video.max_long_minutes")).toBe(20);
    expect(await getSetting(db.pool, "tracks.enabled")).toEqual({ scene_kit: false, tsx: true, collage: true, ai: true });
    const rows = await audit();
    expect(rows.map((x) => (x.detail as { setting: string }).setting).sort()).toEqual(
      ["jobs.concurrent_jobs", "jobs.concurrent_renders", "storage.warn_gb", "tracks.enabled", "video.max_long_minutes"],
    );
    expect(rows.find((x) => (x.detail as { setting: string }).setting === "storage.warn_gb")!.detail).toMatchObject({ from: 50, to: 80 });
  });

  it("an unchanged form audits nothing", async () => {
    await saveSystemSettings(db.pool, good);
    const before = (await audit()).length;
    await saveSystemSettings(db.pool, good);
    expect(await audit()).toHaveLength(before);
  });

  it.each([
    ["zero", { ...good, concurrent_jobs: 0 }],
    ["negative", { ...good, concurrent_renders: -1 }],
    ["fraction", { ...good, storage_warn_gb: 1.5 }],
    ["text", { ...good, max_long_minutes: "abc" }],
    ["huge", { ...good, concurrent_jobs: 100000 }],
    ["missing", { concurrent_jobs: 2 }],
    ["extra key", { ...good, tsx: true }],
  ])("refuses invalid concurrency/limits: %s, and stores nothing", async (_n, input) => {
    const r = await saveSystemSettings(db.pool, input);
    expect(r.ok).toBe(false);
    expect(await getSetting(db.pool, "jobs.concurrent_jobs")).toBe(2);
    expect(await audit()).toHaveLength(0);
  });
});

describe("system status", () => {
  it("reports versions, database, vault and disk without secrets", async () => {
    const s = await getSystemStatus(db.pool, { redisUrl: db.redisUrl });
    expect(s.db.ok).toBe(true);
    expect(s.redis.ok).toBe(true);
    expect(s.versions.node).toBe(process.versions.node);
    expect(s.disk.freeBytes).toBeGreaterThan(0);
    expect(["ok", "missing_key", "wrong_key", "unreadable"]).toContain(s.vault.status);
    const json = JSON.stringify(s);
    expect(json).not.toMatch(/ytstudio_app|test-app-pw|postgres:\/\/|redis:\/\//);
  });

  it("reports an unreachable redis as down instead of throwing", async () => {
    const s = await getSystemStatus(db.pool, { redisUrl: "redis://127.0.0.1:1" });
    expect(s.redis.ok).toBe(false);
    expect(JSON.stringify(s)).not.toContain("127.0.0.1:1");
  });
});
