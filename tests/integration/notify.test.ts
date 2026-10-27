import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTestDb, type TestDb } from "../support/db";
import { listNotifications, loadNotifySettings, markNotificationRead, notifyTransition, unreadCount, type NotifyPorts } from "@/server/db/notify";
import { setSetting } from "@/server/db/settings";

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

const V1 = "11111111-1111-4111-8111-111111111111";
type Msg = { title: string; text: string; message: string };

function ports(over: { desktop?: () => Promise<void>; webhook?: () => Promise<void>; now?: string } = {}) {
  const sent: { channel: string; msg: Msg }[] = [];
  const mk = (channel: string, fail?: () => Promise<void>) => ({
    async send(msg: Msg) {
      if (fail) await fail();
      sent.push({ channel, msg });
    },
  });
  const p: NotifyPorts = {
    channels: { desktop: mk("desktop", over.desktop), webhook: mk("webhook", over.webhook) },
    now: () => new Date(over.now ?? "2026-10-27T06:30:00Z"), // 12:00 in Asia/Kolkata
  };
  return { p, sent };
}
const gate = { event: "script_review", videoId: V1, from: "active", to: "gate.script", transitionId: "run-1" } as const;
const count = async (t: string) => (await db.pool.query(`select count(*)::int n from ${t}`)).rows[0].n as number;
const boom = async () => {
  throw new Error("webhook down https://hooks.example/x?token=SECRETSECRETSECRETSECRETSECRET123");
};

describe("notifyTransition", () => {
  it("writes_the_in_app_row_and_sends_default_channels", async () => {
    const { p, sent } = ports();
    const r = await notifyTransition(db.pool, p, gate);
    expect(r.fired).toBe(true);
    expect(await count("notifications")).toBe(1);
    expect(sent.map((s) => s.channel)).toEqual(["desktop"]); // webhook is off by default
    expect(sent[0]!.msg.title).toBe("Script ready for review");
    const [n] = await listNotifications(db.pool);
    expect(n).toMatchObject({ event: "script_review", videoId: V1, readAt: null });
  });

  it("fires_once_per_transition_even_if_the_worker_redelivers", async () => {
    const { p, sent } = ports();
    const results = await Promise.all([notifyTransition(db.pool, p, gate), notifyTransition(db.pool, p, gate), notifyTransition(db.pool, p, gate)]);
    expect(results.filter((r) => r.fired)).toHaveLength(1);
    expect(await count("notifications")).toBe(1);
    expect(sent).toHaveLength(1);
    // a genuinely new transition (new transition id) notifies again
    expect((await notifyTransition(db.pool, p, { ...gate, transitionId: "run-2" })).fired).toBe(true);
    expect(await count("notifications")).toBe(2);
  });

  it("only_a_transition_into_the_state_fires", async () => {
    const { p, sent } = ports();
    expect((await notifyTransition(db.pool, p, { ...gate, from: "gate.script" })).fired).toBe(false); // already there
    expect((await notifyTransition(db.pool, p, { ...gate, to: "active" })).fired).toBe(false); // not a notifying state
    expect((await notifyTransition(db.pool, p, { ...gate, event: "video_failed" })).fired).toBe(false); // event/state mismatch
    expect(await count("notifications")).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("failing_channel_does_not_block_and_is_audited", async () => {
    await setSetting(db.pool, "notify.events", { ...(await loadNotifySettings(db.pool)).events, script_review: { in_app: true, desktop: true, webhook: true } }, { actor: "session" });
    const { p, sent } = ports({ webhook: boom });
    const r = await notifyTransition(db.pool, p, gate);
    expect(r.fired).toBe(true);
    expect(sent.map((s) => s.channel)).toEqual(["desktop"]); // the other channel still went out
    const audit = await db.pool.query("select detail from audit_log where event = 'notify.delivery_failed'");
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].detail).toMatchObject({ event: "script_review", channel: "webhook" });
    const log = await db.pool.query("select channel, status, error from notification_log order by id");
    expect(log.rows.find((l) => l.channel === "webhook")).toMatchObject({ status: "failed" });
    expect(JSON.stringify([audit.rows, log.rows])).not.toMatch(/SECRETSECRET|token=/);
  });

  it("in_app_row_is_written_even_when_all_other_channels_fail", async () => {
    await setSetting(db.pool, "notify.events", { video_failed: { in_app: true, desktop: true, webhook: true } }, { actor: "session" });
    const { p, sent } = ports({ desktop: boom, webhook: boom });
    const r = await notifyTransition(db.pool, p, { event: "video_failed", videoId: V1, from: "active", to: "failed", transitionId: "t" });
    expect(r.fired).toBe(true);
    expect(sent).toHaveLength(0);
    expect(await count("notifications")).toBe(1);
    expect(await count("audit_log where event = 'notify.delivery_failed'")).toBe(2);
  });

  it("a_channel_that_never_answers_times_out_and_is_audited", async () => {
    const { p } = ports({ desktop: () => new Promise(() => {}) });
    p.channelTimeoutMs = 50;
    expect((await notifyTransition(db.pool, p, gate)).fired).toBe(true);
    expect(await count("audit_log where event = 'notify.delivery_failed'")).toBe(1);
  });

  it("quiet_hours_across_midnight_hold_desktop_but_not_in_app", async () => {
    await setSetting(db.pool, "notify.quiet_hours", { enabled: true, start: "22:00", end: "07:00", tz: "Asia/Kolkata" }, { actor: "session" });
    const { p, sent } = ports({ now: "2026-10-27T19:00:00Z" }); // 00:30 in Kolkata
    await notifyTransition(db.pool, p, gate);
    expect(sent).toHaveLength(0);
    expect(await count("notifications")).toBe(1);
    const log = await db.pool.query("select channel, status from notification_log");
    expect(log.rows).toEqual([{ channel: "desktop", status: "held" }]);
  });

  it("needs_decision_breaks_through_quiet_hours_when_flagged", async () => {
    await setSetting(db.pool, "notify.quiet_hours", { enabled: true, start: "22:00", end: "07:00", tz: "Asia/Kolkata", urgent_break_through: true }, { actor: "session" });
    const { p, sent } = ports({ now: "2026-10-27T19:00:00Z" });
    await notifyTransition(db.pool, p, { event: "needs_decision", videoId: V1, from: "active", to: "needs_decision", transitionId: "x" });
    expect(sent.map((s) => s.channel)).toEqual(["desktop"]);
  });

  it("master_switch_silences_all_but_in_app_record", async () => {
    await setSetting(db.pool, "notify.master", false, { actor: "session" });
    const { p, sent } = ports();
    await notifyTransition(db.pool, p, gate);
    expect(sent).toHaveLength(0);
    expect(await count("notifications")).toBe(1);
  });

  it("notification_text_contains_no_secret_shape", async () => {
    const { p, sent } = ports();
    await notifyTransition(db.pool, p, { ...gate, detail: "topic sk-ant-api03-AbCdEfGhIjKlMnOp Bearer abcdefgh12345678 https://a.example/v?signature=zzz" });
    const [n] = await listNotifications(db.pool);
    const all = JSON.stringify([n, sent]);
    expect(all).not.toMatch(/sk-ant|Bearer abc|signature=zzz/);
  });

  it("works_without_a_video_and_dedupes_on_null_video", async () => {
    const { p } = ports();
    const e = { event: "backup_failed", from: "ok", to: "backup_failed", transitionId: "b1" } as const;
    expect((await notifyTransition(db.pool, p, e)).fired).toBe(true);
    expect((await notifyTransition(db.pool, p, e)).fired).toBe(false);
  });
});

describe("notifications table", () => {
  it("mark_read_and_unread_count", async () => {
    const { p } = ports();
    await notifyTransition(db.pool, p, gate);
    await notifyTransition(db.pool, p, { ...gate, transitionId: "run-2" });
    expect(await unreadCount(db.pool)).toBe(2);
    const [n] = await listNotifications(db.pool);
    await markNotificationRead(db.pool, n!.id);
    expect(await unreadCount(db.pool)).toBe(1);
    expect((await listNotifications(db.pool, { unreadOnly: true })).length).toBe(1);
  });

  it("notification_log_is_append_only_for_the_app_role", async () => {
    const { p } = ports();
    await notifyTransition(db.pool, p, gate);
    await expect(db.pool.query("update notification_log set status = 'sent'")).rejects.toThrow(/permission denied/);
    await expect(db.pool.query("delete from notification_log")).rejects.toThrow(/permission denied/);
  });

  it("settings_defaults_are_used_when_nothing_is_stored", async () => {
    const s = await loadNotifySettings(db.pool);
    expect(s.master).toBe(true);
    expect(s.quietHours.enabled).toBe(false);
    expect(s.events.script_review).toEqual({ in_app: true, desktop: true, webhook: false });
  });
});
