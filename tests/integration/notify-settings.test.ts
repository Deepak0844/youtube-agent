import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTestDb, type TestDb } from "../support/db";
import { loadNotifyForm, saveNotifyForm } from "@/server/db/notify-settings";
import { markAllNotificationsRead, notifyTransition, recentChannelFailures, unreadCount } from "@/server/db/notify";
import { realNotifyPorts } from "@/server/providers/notify/ports";

let db: TestDb;
beforeAll(async () => { db = await withTestDb(); });
afterAll(async () => { await db?.stop(); });
beforeEach(async () => { await db.reset(); });

const base = async () => ({ ...(await loadNotifyForm(db.pool)) });
const gate = (n: number) => ({ event: "script_review", from: "active", to: "gate.script", transitionId: `t${n}` }) as const;

describe("notification settings writer", () => {
  it("saves switches, quiet hours and a public webhook; audits the host only", async () => {
    const f = await base();
    const r = await saveNotifyForm(db.pool, { ...f, master: false, quietHours: { enabled: true, start: "21:00", end: "06:00", tz: "Asia/Kolkata" }, webhookUrl: "https://hooks.example.com/services/SECRETPATH" });
    expect(r.ok).toBe(true);
    const again = await loadNotifyForm(db.pool);
    expect(again.master).toBe(false);
    expect(again.quietHours.start).toBe("21:00");
    expect(again.webhookUrl).toBe("https://hooks.example.com/services/SECRETPATH");
    const audit = JSON.stringify((await db.ownerPool.query("select detail from audit_log where event = 'setting.changed'")).rows);
    expect(audit).toContain("hooks.example.com");
    expect(audit).not.toContain("SECRETPATH");
  });

  it("refuses a private or loopback webhook address and saves nothing", async () => {
    for (const url of ["http://127.0.0.1:9/h", "http://192.168.1.2/h", "http://localhost/h", "http://169.254.169.254/"]) {
      const r = await saveNotifyForm(db.pool, { ...(await base()), master: false, webhookUrl: url });
      expect(r.ok).toBe(false);
    }
    expect((await loadNotifyForm(db.pool)).master).toBe(true);
    expect((await loadNotifyForm(db.pool)).webhookUrl).toBe("");
  });

  it("refuses a bad time or zone", async () => {
    const f = await base();
    expect((await saveNotifyForm(db.pool, { ...f, quietHours: { ...f.quietHours, start: "25:00" } })).ok).toBe(false);
    expect((await saveNotifyForm(db.pool, { ...f, quietHours: { ...f.quietHours, tz: "Nowhere/Land" } })).ok).toBe(false);
  });
});

describe("real ports and the failure banner", () => {
  it("a failing webhook is logged, banner shows it, the pipeline call still returns and the bell keeps the row", async () => {
    const f = await base();
    await saveNotifyForm(db.pool, { ...f, webhookUrl: "https://hooks.invalid.example/h", events: { ...f.events, script_review: { in_app: true, desktop: false, webhook: true } } });
    const ports = await realNotifyPorts(db.pool);
    expect(Object.keys(ports.channels)).toContain("webhook");
    const failing = { channels: { webhook: { send: async () => { throw new Error("down"); } } }, channelTimeoutMs: 200 };
    const r = await notifyTransition(db.pool, failing, gate(1));
    expect(r.fired).toBe(true);
    expect(await unreadCount(db.pool)).toBe(1);
    expect(await recentChannelFailures(db.pool)).toMatchObject([{ channel: "webhook", count: 1 }]);
    // a later good send clears the banner
    await notifyTransition(db.pool, { channels: { webhook: { send: async () => {} } } }, gate(2));
    expect(await recentChannelFailures(db.pool)).toEqual([]);
  });

  it("mark all read empties the unread count", async () => {
    await notifyTransition(db.pool, { channels: {} }, gate(1));
    await notifyTransition(db.pool, { channels: {} }, gate(2));
    expect(await unreadCount(db.pool)).toBe(2);
    await markAllNotificationsRead(db.pool);
    expect(await unreadCount(db.pool)).toBe(0);
  });
});
