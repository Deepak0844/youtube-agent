import { describe, expect, it } from "vitest";
import { SCHEDULER_DEFAULTS, draftStop, dueJobs, istParts, schedulerSchema } from "@/server/core/scheduler";

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
    expect(dueJobs({ ...SCHEDULER_DEFAULTS, analytics: false, competitors: false }, new Date("2026-11-07T12:00:00Z"))).toEqual([]);
  });
  it("competitors_are_not_due_before_09_30_ist", () => {
    expect(dueJobs(SCHEDULER_DEFAULTS, new Date("2026-11-07T03:59:00Z")).map((j) => j.job)).toEqual(["analytics"]); // 09:29 IST
  });
  it("competitors_are_due_from_09_30_ist_with_a_per_day_key", () => {
    expect(dueJobs(SCHEDULER_DEFAULTS, new Date("2026-11-07T04:00:00Z"))).toEqual([
      { job: "analytics", runKey: "2026-11-07" },
      { job: "competitors", runKey: "2026-11-07" },
    ]);
  });
  it("competitors_off_means_only_analytics_is_due", () => {
    expect(dueJobs({ ...SCHEDULER_DEFAULTS, competitors: false }, new Date("2026-11-07T12:00:00Z")).map((j) => j.job)).toEqual(["analytics"]);
  });
});

describe("dueJobs: weekly review and optimizer", () => {
  const on = { ...SCHEDULER_DEFAULTS, analytics: false, competitors: false, weekly_review: true, weekly_day: 0, weekly_hour: 20, optimizer: true, optimizer_hour: 22 };
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

describe("drafting window", () => {
  const on = { ...SCHEDULER_DEFAULTS, enabled: true, hour: 2, analytics: false, competitors: false, weekly_review: false };
  it("is_due_from_hour_for_three_hours_keyed_by_the_start_date", () => {
    const at = (iso: string) => dueJobs(on, new Date(iso));
    expect(at("2026-11-06T20:30:00Z")).toEqual([{ job: "drafting", runKey: "2026-11-07" }]); // 02:00 IST
    expect(at("2026-11-06T23:29:00Z")).toEqual([{ job: "drafting", runKey: "2026-11-07" }]); // 04:59 IST
    expect(at("2026-11-06T23:30:00Z")).toEqual([]); // 05:00 IST
    expect(at("2026-11-06T20:29:00Z")).toEqual([]); // 01:59 IST
  });
  it("wraps_past_midnight_and_keeps_the_start_date", () => {
    const w = { ...on, hour: 23 };
    expect(dueJobs(w, new Date("2026-11-07T18:00:00Z"))).toEqual([{ job: "drafting", runKey: "2026-11-07" }]); // 23:30 IST
    expect(dueJobs(w, new Date("2026-11-07T19:00:00Z"))).toEqual([{ job: "drafting", runKey: "2026-11-07" }]); // 00:30 IST next day
    expect(dueJobs(w, new Date("2026-11-07T20:00:00Z"))).toEqual([{ job: "drafting", runKey: "2026-11-07" }]); // 01:30 IST
    expect(dueJobs(w, new Date("2026-11-07T21:00:00Z"))).toEqual([]); // 02:30 IST
  });
  it("is_never_due_when_disabled", () => {
    expect(dueJobs({ ...on, enabled: false }, new Date("2026-11-06T21:00:00Z"))).toEqual([]);
  });
});

describe("draftStop", () => {
  const s = { enabled: true, max_drafts: 2, max_pending: 3 };
  const st = { started: 0, failed: 0, waiting: 0, budgetLeftMicro: null as number | null };
  it("allows_a_draft_when_every_cap_has_room_and_no_limit_counts_as_enough", () => {
    expect(draftStop(s, st)).toBeNull();
    expect(draftStop(s, { ...st, budgetLeftMicro: 1_000_000 })).toBeNull();
  });
  it("stops_for_each_cap", () => {
    expect(draftStop({ ...s, enabled: false }, st)).toBe("disabled");
    expect(draftStop(s, { ...st, started: 2 })).toBe("max_drafts");
    expect(draftStop(s, { ...st, waiting: 2, started: 1 })).toBe("max_pending");
    expect(draftStop(s, { ...st, budgetLeftMicro: 999_999 })).toBe("low_budget");
    expect(draftStop(s, { ...st, failed: 2 })).toBe("failures");
  });
});
