import os from "node:os";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTestDb, type TestDb } from "../support/db";
import { getSetting, setSessionSettings } from "@/server/db/settings";
import { listAudit } from "@/server/db/audit";
import { loadLocalServices, loadSystemSettings, saveAssetSettings, saveLocalServices, saveSystemSettings, saveVoiceServer } from "@/server/db/system-settings";
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
afterEach(async () => {
  await db.ownerPool.query("drop trigger if exists fail_audit_t on audit_log");
  await db.ownerPool.query("drop function if exists fail_audit()");
});

const OWN = new Set([5432, 6379]);
const audit = async () => (await listAudit(db.pool, { eventPrefix: "setting.changed" })).rows;
const settingOf = (r: { detail: unknown }) => (r.detail as { setting: string }).setting;

// Makes every audit insert for one setting fail, to prove the write and its audit row are one unit.
async function failAuditFor(setting: string) {
  await db.ownerPool.query(`create function fail_audit() returns trigger language plpgsql as $$
    begin if new.detail->>'setting' = '${setting}' then raise exception 'audit down'; end if; return new; end $$`);
  await db.ownerPool.query("create trigger fail_audit_t before insert on audit_log for each row execute function fail_audit()");
}

describe("local service list (app role)", () => {
  it("saves a valid list, normalised, and audits old and new", async () => {
    const r = await saveLocalServices(db.pool, "localhost:11434\nLOCALHOST:11434\n127.0.0.1:1234", { ownPorts: OWN, confirmed: true });
    expect(r).toEqual({ ok: true, changed: true });
    expect(await getSetting(db.pool, "network.local_services")).toEqual(["localhost:11434", "127.0.0.1:1234"]);
    expect(await loadLocalServices(db.pool, OWN)).toEqual(["localhost:11434", "127.0.0.1:1234"]);
    const [row] = await audit();
    expect(row!.detail).toMatchObject({ setting: "network.local_services", from: [], to: ["localhost:11434", "127.0.0.1:1234"] });
  });

  it("removal is audited too", async () => {
    await saveLocalServices(db.pool, "localhost:11434\n127.0.0.1:1234", { ownPorts: OWN, confirmed: true });
    await saveLocalServices(db.pool, "localhost:11434", { ownPorts: OWN, confirmed: true });
    const rows = await audit();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.detail).toMatchObject({ from: ["localhost:11434", "127.0.0.1:1234"], to: ["localhost:11434"] });
  });

  it("an unchanged save writes nothing and audits nothing", async () => {
    await saveLocalServices(db.pool, "localhost:11434", { ownPorts: OWN, confirmed: true });
    const r = await saveLocalServices(db.pool, "LOCALHOST:11434\n", { ownPorts: OWN, confirmed: true });
    expect(r).toEqual({ ok: true, changed: false });
    expect(await audit()).toHaveLength(1);
  });

  it.each(["0.0.0.0:11434", "[::]:80", "127.0.0.1:5432", "localhost:6379", "169.254.169.254:80", "2130706433:80", "0x7f000001:80", "[::ffff:127.0.0.1]:80", "user@localhost:80", "*:80", "localhost.:80", "host.0x:80"])(
    "refuses %s and leaves the stored list and audit log untouched",
    async (bad) => {
      await saveLocalServices(db.pool, "localhost:11434", { ownPorts: OWN, confirmed: true });
      const r = await saveLocalServices(db.pool, `localhost:1234\n${bad}`, { ownPorts: OWN, confirmed: true });
      expect(r.ok).toBe(false);
      expect(await getSetting(db.pool, "network.local_services")).toEqual(["localhost:11434"]);
      expect(await audit()).toHaveLength(1);
    },
  );

  it("the cap on entries is enforced", async () => {
    const many = Array.from({ length: 21 }, (_, i) => `localhost:${20000 + i}`).join("\n");
    expect((await saveLocalServices(db.pool, many, { ownPorts: OWN, confirmed: true })).ok).toBe(false);
  });

  it("loadLocalServices drops anything invalid that was written behind the form's back", async () => {
    await db.ownerPool.query(`insert into settings (key, value, updated_by) values ('network.local_services', '["localhost:11434","0.0.0.0:80","*:1",5]'::jsonb, 'system')
       on conflict (key) do update set value = excluded.value`);
    expect(await loadLocalServices(db.pool, OWN)).toEqual(["localhost:11434"]);
  });

  it("S3: if the audit write fails, the list does not change and the caller gets a generic error", async () => {
    await saveLocalServices(db.pool, "localhost:11434", { ownPorts: OWN, confirmed: true });
    await failAuditFor("network.local_services");
    const r = await saveLocalServices(db.pool, "localhost:11434\n127.0.0.1:1234", { ownPorts: OWN, confirmed: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).not.toMatch(/audit|boom|trigger/i);
    expect(await getSetting(db.pool, "network.local_services")).toEqual(["localhost:11434"]);
    expect(await audit()).toHaveLength(1);
  });

  it("in production an entry is refused (with the names still missing) until the own-service URLs are set; clearing is allowed", async () => {
    const prod = { NODE_ENV: "production" };
    const r = await saveLocalServices(db.pool, "localhost:11434", { ownPorts: OWN, env: prod });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.lines)).toMatch(/RENDER_RUNNER_URL.*FETCHER_URL.*SEARXNG_URL.*EGRESS_PROXY_URL/);
    expect(await getSetting(db.pool, "network.local_services")).toEqual([]);
    expect((await saveLocalServices(db.pool, "", { ownPorts: OWN, env: prod })).ok).toBe(true);
  });

  it("an own-service setting that cannot be read fails closed: nothing saved, list shows empty", async () => {
    const broken = { SEARXNG_URL: "not a url" };
    expect((await saveLocalServices(db.pool, "localhost:11434", { env: broken, confirmed: true })).ok).toBe(false);
    expect(await getSetting(db.pool, "network.local_services")).toEqual([]);
    await saveLocalServices(db.pool, "localhost:11434", { ownPorts: OWN, confirmed: true });
    expect(await loadLocalServices(db.pool, undefined, broken)).toEqual([]);
  });

  it("N1: an entry the audit redaction would blank is stored as a hash instead of [redacted]", async () => {
    const longHost = `${"a".repeat(40)}.lan:8000`;
    await saveLocalServices(db.pool, `${longHost}\nlocalhost:11434`, { ownPorts: OWN, confirmed: true });
    const [row] = await audit();
    const to = (row!.detail as { to: string[] }).to;
    expect(JSON.stringify(row!.detail)).not.toContain("[redacted]");
    expect(to[1]).toBe("localhost:11434");
    expect(to[0]).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(to[0]).not.toContain("aaaa");
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
    expect(rows.map(settingOf).sort()).toEqual(["jobs.concurrent_jobs", "jobs.concurrent_renders", "storage.warn_gb", "tracks.enabled", "video.max_long_minutes"]);
    expect(rows.find((x) => settingOf(x) === "storage.warn_gb")!.detail).toMatchObject({ from: 50, to: 80 });
  });

  it("an unchanged form audits nothing", async () => {
    await saveSystemSettings(db.pool, good);
    const before = (await audit()).length;
    await saveSystemSettings(db.pool, good);
    expect(await audit()).toHaveLength(before);
  });

  it("loadSystemSettings reads back what was saved", async () => {
    await saveSystemSettings(db.pool, good);
    expect(await loadSystemSettings(db.pool)).toMatchObject({ renders: 2, jobs: 3, warnGb: 80, longMinutes: 20, sceneKit: false });
  });

  it.each([
    ["zero", { ...good, concurrent_jobs: 0 }],
    ["negative", { ...good, concurrent_renders: -1 }],
    ["fraction", { ...good, storage_warn_gb: 1.5 }],
    ["text", { ...good, max_long_minutes: "abc" }],
    ["exponent", { ...good, max_long_minutes: "1e1" }],
    ["hex", { ...good, concurrent_jobs: "0x10" }],
    ["plus sign", { ...good, concurrent_jobs: "+3" }],
    ["padded", { ...good, concurrent_jobs: " 3" }],
    ["leading zero", { ...good, concurrent_jobs: "03" }],
    ["decimal string", { ...good, concurrent_jobs: "3.0" }],
    ["empty", { ...good, concurrent_jobs: "" }],
    ["huge", { ...good, concurrent_jobs: 100000 }],
    ["missing", { concurrent_jobs: 2 }],
    ["extra key", { ...good, tsx: true }],
  ])("refuses invalid limits: %s, and stores nothing", async (_n, input) => {
    const r = await saveSystemSettings(db.pool, input);
    expect(r.ok).toBe(false);
    expect(await getSetting(db.pool, "jobs.concurrent_jobs")).toBe(2);
    expect(await audit()).toHaveLength(0);
  });

  it("accepts plain decimal strings from a form", async () => {
    expect((await saveSystemSettings(db.pool, { ...good, concurrent_jobs: "7" })).ok).toBe(true);
    expect(await getSetting(db.pool, "jobs.concurrent_jobs")).toBe(7);
  });

  it("N4: all five keys are one unit: a failure on the third rolls back the first two", async () => {
    await failAuditFor("storage.warn_gb");
    const r = await saveSystemSettings(db.pool, good);
    expect(r.ok).toBe(false);
    expect(await getSetting(db.pool, "jobs.concurrent_renders")).toBe(1);
    expect(await getSetting(db.pool, "jobs.concurrent_jobs")).toBe(2);
    expect(await getSetting(db.pool, "storage.warn_gb")).toBe(50);
    expect(await getSetting(db.pool, "tracks.enabled")).toEqual({ scene_kit: true, tsx: true, collage: true, ai: true });
    expect(await audit()).toHaveLength(0);
  });

  it("N4: two saves at once leave one whole form, never a mixture", async () => {
    const a = { concurrent_renders: 2, concurrent_jobs: 4, storage_warn_gb: 60, max_long_minutes: 30, scene_kit: true };
    const b = { concurrent_renders: 3, concurrent_jobs: 5, storage_warn_gb: 70, max_long_minutes: 40, scene_kit: false };
    for (let i = 0; i < 5; i++) {
      await Promise.all([saveSystemSettings(db.pool, a), saveSystemSettings(db.pool, b)]);
      const s = await loadSystemSettings(db.pool);
      const got = { concurrent_renders: s.renders, concurrent_jobs: s.jobs, storage_warn_gb: s.warnGb, max_long_minutes: s.longMinutes, scene_kit: s.sceneKit };
      expect([a, b]).toContainEqual(got);
    }
  });

  it("tracks other than scene kit are kept as they were", async () => {
    await db.ownerPool.query(`insert into settings (key, value, updated_by) values ('tracks.enabled', '{"scene_kit":true,"tsx":false,"collage":true,"ai":false}'::jsonb, 'system')
       on conflict (key) do update set value = excluded.value`);
    await saveSystemSettings(db.pool, { ...good, scene_kit: false });
    expect(await getSetting(db.pool, "tracks.enabled")).toEqual({ scene_kit: false, tsx: false, collage: true, ai: false });
  });
});

describe("setSessionSettings is limited to the keys this page writes", () => {
  const noAudit = async () => undefined;
  it.each(["policy.allow_public", "policy.require_evidence", "display.currency", "engine.retry_attempts", "breaker.threshold"])(
    "refuses %s and touches nothing",
    async (key) => {
      const value = key.startsWith("policy") ? true : key === "display.currency" ? "EUR" : 9;
      await expect(setSessionSettings(db.pool, [{ key, value }], noAudit)).rejects.toThrow(/not writable here/);
      expect((await db.pool.query("select count(*)::int n from settings where key = $1", [key])).rows[0].n).toBe(0);
    },
  );
  it("accepts the asset keys, which the asset settings writer saves", async () => {
    const r = await saveAssetSettings(db.pool, { retention_days: 9, unused_days: 30, trash_days: 7, max_image_mb: 25, max_audio_mb: 200, max_megapixels: 50, max_batch_files: 100, total_gb: 5 });
    expect(r.ok).toBe(true);
    expect((await db.pool.query("select value from settings where key = 'assets.retention_days'")).rows[0].value).toBe(9);
  });
  it("refuses an unknown key and a batch with one bad key as a whole", async () => {
    await expect(setSessionSettings(db.pool, [{ key: "nope", value: 1 }], noAudit)).rejects.toThrow();
    await expect(
      setSessionSettings(db.pool, [{ key: "storage.warn_gb", value: 70 }, { key: "policy.allow_public", value: true }], noAudit),
    ).rejects.toThrow(/not writable here/);
    expect(await getSetting(db.pool, "storage.warn_gb")).toBe(50);
  });
  it("still writes the page's own keys", async () => {
    await setSessionSettings(db.pool, [{ key: "network.local_services", value: ["localhost:11434"] }], noAudit);
    expect(await getSetting(db.pool, "network.local_services")).toEqual(["localhost:11434"]);
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

  it("N7: the storage folder is shown relative or masked, never with the home directory", async () => {
    const s = await getSystemStatus(db.pool, { redisUrl: db.redisUrl });
    expect(s.disk.root).not.toContain(os.homedir());
    expect(s.disk.root).not.toMatch(/^\//);
  });

  it("reports an unreachable redis as down instead of throwing", async () => {
    const s = await getSystemStatus(db.pool, { redisUrl: "redis://127.0.0.1:1" });
    expect(s.redis.ok).toBe(false);
    expect(JSON.stringify(s)).not.toContain("127.0.0.1:1");
  });
});

describe("voice servers and the add-needs-confirmation rule", () => {
  const OWNP = new Set([5432, 6379]);
  it("saves a valid VoiceStudio address and audits old -> new", async () => {
    expect(await saveVoiceServer(db.pool, "voicestudio_url", "http://127.0.0.1:3900")).toEqual({ ok: true, changed: true });
    expect(await getSetting(db.pool, "voice.voicestudio_url")).toBe("http://127.0.0.1:3900");
    const [row] = await audit();
    expect(row!.detail).toMatchObject({ setting: "voice.voicestudio_url", from: "", to: "http://127.0.0.1:3900" });
    expect((await db.pool.query("select updated_by from settings where key='voice.voicestudio_url'")).rows[0].updated_by).toBe("session");
  });
  it.each([
    ["voicestudio_url", "http://192.168.1.5:3900"],
    ["voicestudio_url", "http://u:p@127.0.0.1:3900"],
    ["local_url", "file:///etc/passwd"],
    ["azure_region", "West Europe"],
    ["network.local_services", "localhost:11434"],
    ["__proto__", "x"],
  ])("refuses %s=%s and leaves the stored value alone", async (field, value) => {
    await saveVoiceServer(db.pool, "local_url", "http://127.0.0.1:8880");
    const before = await audit();
    const r = await saveVoiceServer(db.pool, field, value);
    expect(r.ok).toBe(false);
    expect(await getSetting(db.pool, "voice.local_url")).toBe("http://127.0.0.1:8880");
    expect(await getSetting(db.pool, "voice.voicestudio_url")).toBe("");
    expect(await getSetting(db.pool, "voice.azure_region")).toBe("");
    expect(await audit()).toHaveLength(before.length);
  });
  it("clearing is allowed", async () => {
    await saveVoiceServer(db.pool, "azure_region", "westeurope");
    expect(await saveVoiceServer(db.pool, "azure_region", "")).toEqual({ ok: true, changed: true });
    expect(await getSetting(db.pool, "voice.azure_region")).toBe("");
  });
  it("adding a local service without confirmation saves nothing; removing needs none", async () => {
    const r = await saveLocalServices(db.pool, "127.0.0.1:3900", { ownPorts: OWNP });
    expect(r.ok).toBe(false);
    expect(await getSetting(db.pool, "network.local_services")).toEqual([]);
    expect((await saveLocalServices(db.pool, "127.0.0.1:3900", { ownPorts: OWNP, confirmed: true })).ok).toBe(true);
    expect((await saveLocalServices(db.pool, "", { ownPorts: OWNP })).ok).toBe(true);
    expect(await getSetting(db.pool, "network.local_services")).toEqual([]);
  });
  it("cloud metadata stays refused even when confirmed", async () => {
    for (const e of ["169.254.169.254:80", "[fd00:ec2::254]:80", "169.254.1.1:80"]) {
      expect((await saveLocalServices(db.pool, e, { ownPorts: OWNP, confirmed: true })).ok, e).toBe(false);
    }
    expect(await getSetting(db.pool, "network.local_services")).toEqual([]);
  });
});
