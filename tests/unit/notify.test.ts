import { describe, expect, it } from "vitest";
import { NOTIFY_EVENTS, NOTIFY_EVENT_IDS, decideDelivery, defaultSwitches, eventForState, localMinutes, scrubText, type NotifySettings } from "@/server/core/notify";
import { SETTINGS } from "@/server/core/settings-registry";
import { isAuditEvent } from "@/server/core/audit-events";

const base = (over: Partial<NotifySettings> = {}): NotifySettings => ({
  master: true,
  quietHours: { enabled: false, start: "22:00", end: "07:00", tz: "Asia/Kolkata" },
  events: {},
  ...over,
});
const q = (start: string, end: string, tz: string, extra = {}) => ({ enabled: true, start, end, tz, ...extra });
const by = (d: ReturnType<typeof decideDelivery>) => Object.fromEntries(d.map((x) => [x.channel, x]));

describe("notify events and defaults", () => {
  it("has_the_three_groups_with_doc_defaults", () => {
    expect(defaultSwitches("script_review")).toEqual({ in_app: true, desktop: true, webhook: false });
    expect(defaultSwitches("video_failed")).toEqual({ in_app: true, desktop: true, webhook: false });
    expect(defaultSwitches("uploaded_private")).toEqual({ in_app: true, desktop: false, webhook: false });
    expect(NOTIFY_EVENTS.needs_decision.urgent && NOTIFY_EVENTS.spend_cap_hit.urgent).toBe(true);
  });

  it("only_gate_and_failure_statuses_notify", () => {
    for (const s of ["active", "waiting", "done", "cancelled", "running", "succeeded", "queued", ""]) expect(eventForState(s), s).toBeNull();
    expect(eventForState("gate.script")).toBe("script_review");
    expect(eventForState("failed")).toBe("video_failed");
    expect(eventForState("needs_decision")).toBe("needs_decision");
    expect(new Set(NOTIFY_EVENT_IDS.map((i) => NOTIFY_EVENTS[i].state)).size).toBe(NOTIFY_EVENT_IDS.length);
  });

  it("settings_registry_has_the_notify_keys_and_none_are_safety", () => {
    for (const k of ["notify.master", "notify.quiet_hours", "notify.events"] as const) {
      expect(SETTINGS[k].safety, k).toBe(false);
      expect(SETTINGS[k].schema.safeParse(SETTINGS[k].default).success, k).toBe(true);
    }
    expect(SETTINGS["notify.master"].default).toBe(true);
    expect(SETTINGS["notify.quiet_hours"].default).toEqual({ enabled: false, start: "22:00", end: "07:00", tz: "Asia/Kolkata" });
    expect(Object.keys(SETTINGS["notify.events"].default as object).sort()).toEqual([...NOTIFY_EVENT_IDS].sort());
    expect(SETTINGS["notify.events"].schema.safeParse({ nope: { in_app: true } }).success).toBe(false);
    expect(SETTINGS["notify.quiet_hours"].schema.safeParse({ enabled: true, start: "25:00", end: "07:00", tz: "Asia/Kolkata" }).success).toBe(false);
    expect(SETTINGS["notify.quiet_hours"].schema.safeParse({ enabled: true, start: "22:00", end: "07:00", tz: "Not/AZone" }).success).toBe(false);
  });

  it("delivery_failure_is_an_audit_event", () => {
    expect(isAuditEvent("notify.delivery_failed")).toBe(true);
  });
});

describe("decideDelivery", () => {
  it("default_sends_in_app_and_desktop_not_webhook", () => {
    const d = by(decideDelivery("script_review", base(), 600));
    expect(d.in_app).toEqual({ channel: "in_app", deliver: true, held: false });
    expect(d.desktop!.deliver).toBe(true);
    expect(d.webhook!.deliver).toBe(false);
  });

  it("per_event_switch_turns_a_channel_on_or_off", () => {
    const d = by(decideDelivery("script_review", base({ events: { script_review: { desktop: false, webhook: true } } }), 600));
    expect(d.desktop!.deliver).toBe(false);
    expect(d.webhook!.deliver).toBe(true);
  });

  it("master_switch_silences_all_but_in_app_record", () => {
    const d = by(decideDelivery("video_failed", base({ master: false, events: { video_failed: { webhook: true } } }), 600));
    expect(d.in_app!.deliver).toBe(true);
    expect(d.desktop!.deliver).toBe(false);
    expect(d.webhook!.deliver).toBe(false);
    expect(d.desktop!.held).toBe(false);
  });

  it("quiet_hours_across_midnight_hold_desktop_but_not_in_app", () => {
    const s = base({ quietHours: q("22:00", "07:00", "Asia/Kolkata") });
    for (const m of [22 * 60, 23 * 60 + 59, 0, 6 * 60 + 59]) {
      const d = by(decideDelivery("script_review", s, m));
      expect(d.desktop, String(m)).toEqual({ channel: "desktop", deliver: false, held: true });
      expect(d.in_app!.deliver).toBe(true);
    }
    for (const m of [7 * 60, 12 * 60, 21 * 60 + 59]) expect(by(decideDelivery("script_review", s, m)).desktop!.deliver, String(m)).toBe(true);
  });

  it("same_day_window_and_empty_window", () => {
    const s = base({ quietHours: q("13:00", "14:00", "Asia/Kolkata") });
    expect(by(decideDelivery("script_review", s, 13 * 60 + 30)).desktop!.held).toBe(true);
    expect(by(decideDelivery("script_review", s, 14 * 60)).desktop!.deliver).toBe(true);
    const e = base({ quietHours: q("10:00", "10:00", "Asia/Kolkata") });
    expect(by(decideDelivery("script_review", e, 10 * 60)).desktop!.deliver).toBe(true);
  });

  it("needs_decision_breaks_through_quiet_hours_when_flagged", () => {
    const flagged = base({ quietHours: q("22:00", "07:00", "Asia/Kolkata", { urgent_break_through: true }) });
    const unflagged = base({ quietHours: q("22:00", "07:00", "Asia/Kolkata") });
    expect(by(decideDelivery("needs_decision", flagged, 60)).desktop!.deliver).toBe(true);
    expect(by(decideDelivery("spend_cap_hit", flagged, 60)).desktop!.deliver).toBe(true);
    expect(by(decideDelivery("needs_decision", unflagged, 60)).desktop!.held).toBe(true);
    expect(by(decideDelivery("video_failed", flagged, 60)).desktop!.held).toBe(true); // not urgent
  });

  it("quiet_hours_on_a_dst_change_day", () => {
    // New York, 2026-03-08: clocks jump 02:00 EST -> 03:00 EDT. Window 01:00-03:30 local.
    const tz = "America/New_York";
    const s = base({ quietHours: q("01:00", "03:30", tz) });
    const at = (iso: string) => decideDelivery("script_review", s, localMinutes(new Date(iso), tz));
    expect(localMinutes(new Date("2026-03-08T07:00:00Z"), tz)).toBe(3 * 60); // 03:00 EDT
    expect(by(at("2026-03-08T06:30:00Z")).desktop!.held).toBe(true); // 01:30 EST
    expect(by(at("2026-03-08T07:00:00Z")).desktop!.held).toBe(true); // 03:00 EDT (a fixed -5 offset would say 02:00, also inside)
    expect(by(at("2026-03-08T07:45:00Z")).desktop!.deliver).toBe(true); // 03:45 EDT is outside; a fixed -5 offset would say 02:45 (inside)
    // and the day after, back to a normal offset
    expect(localMinutes(new Date("2026-03-09T05:30:00Z"), tz)).toBe(1 * 60 + 30);
  });

  it("local_minutes_uses_the_iana_zone", () => {
    expect(localMinutes(new Date("2026-10-27T18:30:00Z"), "Asia/Kolkata")).toBe(0);
  });
});

describe("scrubText", () => {
  it("notification_text_contains_no_secret_shape", () => {
    const dirty = [
      "key sk-ant-api03-AbCdEfGhIjKlMnOp",
      "AIzaSyA1234567890abcdefghijklmnopqrstu",
      "Authorization: Bearer abc.def.ghi-123456",
      "https://x.example/v.mp4?X-Amz-Signature=deadbeef&Expires=1",
      "https://x.example/v?token=abc123",
      "0123456789abcdef0123456789abcdef0123456789abcdef",
    ].join(" | ");
    const clean = scrubText(dirty);
    for (const bad of ["sk-ant", "AIzaSy", "Bearer abc", "X-Amz", "token=abc", "0123456789abcdef0123"]) expect(clean, bad).not.toContain(bad);
    expect(scrubText("Script ready for review")).toBe("Script ready for review");
  });
});
