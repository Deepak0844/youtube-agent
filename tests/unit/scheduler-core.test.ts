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
