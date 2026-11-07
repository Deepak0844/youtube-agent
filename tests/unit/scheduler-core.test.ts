import { describe, expect, it } from "vitest";
import { SCHEDULER_DEFAULTS, dueJobs, istParts, schedulerSchema } from "@/server/core/scheduler";

describe("scheduler settings", () => {
  it("defaults_match_the_old_app_and_overnight_drafting_is_off", () => {
    expect(schedulerSchema.parse(SCHEDULER_DEFAULTS)).toEqual(SCHEDULER_DEFAULTS);
    expect(SCHEDULER_DEFAULTS).toMatchObject({ enabled: false, hour: 2, max_drafts: 2, max_pending: 3, weekly_day: 6, weekly_hour: 20, optimizer: false, optimizer_hour: 22, competitors: true, tracks: ["tsx"] });
  });
  it.each([{ hour: 24 }, { max_drafts: 6 }, { max_pending: 0 }, { weekly_day: 7 }, { tracks: ["ai"] }, { nope: 1 }])("rejects_%j", (bad) => {
    expect(schedulerSchema.safeParse({ ...SCHEDULER_DEFAULTS, ...bad }).success).toBe(false);
  });
});

describe("dueJobs", () => {
  it("istParts_use_ist_not_utc", () => {
    expect(istParts(new Date("2026-11-07T20:00:00Z"))).toEqual({ date: "2026-11-08", hour: 1 });
  });
  it("analytics_is_not_due_before_09_00_ist", () => {
    expect(dueJobs(SCHEDULER_DEFAULTS, new Date("2026-11-07T03:00:00Z"))).toEqual([]); // 08:30 IST
  });
  it("analytics_is_due_from_09_00_ist_with_a_per_day_key", () => {
    expect(dueJobs(SCHEDULER_DEFAULTS, new Date("2026-11-07T03:30:00Z"))).toEqual([{ job: "analytics", runKey: "2026-11-07" }]);
  });
  it("analytics_off_means_nothing_due", () => {
    expect(dueJobs({ ...SCHEDULER_DEFAULTS, analytics: false }, new Date("2026-11-07T12:00:00Z"))).toEqual([]);
  });
});

describe("dueJobs: weekly review and optimizer", () => {
  const on = { ...SCHEDULER_DEFAULTS, analytics: false, weekly_review: true, weekly_day: 0, weekly_hour: 20, optimizer: true, optimizer_hour: 22 };
  const MON_21_IST = new Date("2026-11-09T15:30:00Z"); // Monday 21:00 IST
  it("weekly_review_is_due_on_the_chosen_weekday_from_the_chosen_hour_with_an_iso_week_key", () => {
    expect(dueJobs({ ...on, optimizer: false }, MON_21_IST)).toEqual([{ job: "weekly_review", runKey: "2026-W46" }]);
  });
  it("weekly_review_is_not_due_before_the_hour_or_on_another_day", () => {
    expect(dueJobs(on, new Date("2026-11-09T14:00:00Z")).map((j) => j.job)).not.toContain("weekly_review"); // Monday 19:30 IST
    expect(dueJobs(on, new Date("2026-11-10T15:30:00Z")).map((j) => j.job)).not.toContain("weekly_review"); // Tuesday
  });
  it("sunday_is_day_6", () => {
    const s = { ...on, weekly_day: 6, optimizer: false };
    expect(dueJobs(s, new Date("2026-11-08T15:30:00Z"))).toEqual([{ job: "weekly_review", runKey: "2026-W45" }]);
  });
  it("weekday_uses_ist_not_utc", () => {
    // Sunday 20:00 UTC is already Monday 01:30 IST.
    expect(dueJobs({ ...on, weekly_hour: 1, optimizer: false }, new Date("2026-11-08T20:00:00Z"))).toEqual([{ job: "weekly_review", runKey: "2026-W46" }]);
  });
  it("optimizer_is_due_from_its_hour_with_a_per_day_key", () => {
    const o = { ...on, weekly_review: false };
    expect(dueJobs(o, new Date("2026-11-10T16:30:00Z"))).toEqual([{ job: "optimizer", runKey: "2026-11-10" }]); // 22:00 IST
    expect(dueJobs(o, new Date("2026-11-10T16:00:00Z"))).toEqual([]); // 21:30 IST
  });
  it("switched_off_means_nothing", () => {
    expect(dueJobs({ ...on, weekly_review: false, optimizer: false }, MON_21_IST)).toEqual([]);
  });
});
