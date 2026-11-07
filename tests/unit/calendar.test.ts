import { describe, expect, it } from "vitest";
import { nextDraftWindow, parseRunCounts } from "@/server/core/calendar";

// IST = UTC+5:30.
const ist = (s: string) => new Date(`${s}+05:30`);
const iso = (d: Date) => d.toISOString();

describe("nextDraftWindow", () => {
  it("before the start hour: the window starts later today", () => {
    const w = nextDraftWindow(ist("2026-11-08T00:30:00"), 2);
    expect(iso(w.start)).toBe(iso(ist("2026-11-08T02:00:00")));
    expect(w.inWindow).toBe(false);
  });
  it("after the window: the next one starts tomorrow", () => {
    const w = nextDraftWindow(ist("2026-11-08T10:00:00"), 2);
    expect(iso(w.start)).toBe(iso(ist("2026-11-09T02:00:00")));
    expect(w.inWindow).toBe(false);
  });
  it("inside the window: reports the current start", () => {
    const w = nextDraftWindow(ist("2026-11-08T03:59:00"), 2);
    expect(iso(w.start)).toBe(iso(ist("2026-11-08T02:00:00")));
    expect(w.inWindow).toBe(true);
  });
  it("the window ends at start + 3h exactly", () => {
    expect(nextDraftWindow(ist("2026-11-08T05:00:00"), 2).inWindow).toBe(false);
  });
  it("wraps past midnight: start 23, now 01:00 is inside last night's window", () => {
    const w = nextDraftWindow(ist("2026-11-08T01:00:00"), 23);
    expect(iso(w.start)).toBe(iso(ist("2026-11-07T23:00:00")));
    expect(w.inWindow).toBe(true);
  });
  it("wraps past midnight: start 23, now 10:00 waits for tonight", () => {
    const w = nextDraftWindow(ist("2026-11-08T10:00:00"), 23);
    expect(iso(w.start)).toBe(iso(ist("2026-11-08T23:00:00")));
    expect(w.inWindow).toBe(false);
  });
  it("start hour 0 at midnight sharp is inside", () => {
    const w = nextDraftWindow(ist("2026-11-08T00:00:00"), 0);
    expect(iso(w.start)).toBe(iso(ist("2026-11-08T00:00:00")));
    expect(w.inWindow).toBe(true);
  });
});

describe("parseRunCounts", () => {
  it("reads the drafting run message", () => {
    expect(parseRunCounts("2 started, 1 failed, 3 skipped as duplicates; stopped: nightly draft limit reached")).toEqual({ started: 2, failed: 1, skipped: 3 });
  });
  it("returns null for anything else", () => {
    expect(parseRunCounts(null)).toBeNull();
    expect(parseRunCounts("The job failed (Error). Check the worker log.")).toBeNull();
  });
});
