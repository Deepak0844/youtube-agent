import { describe, expect, it } from "vitest";
import { admitBreaker, breakerAllows, breakerStep, CLOSED, holdUntilMs, type BreakerState } from "@/server/core/breaker";

const cfg = { threshold: 3, cooldownMs: 900_000 };
const run = (events: Array<"failure" | "success" | "reset">, t = 0, s: BreakerState = CLOSED) => events.reduce((st, e) => breakerStep(st, e, t, cfg), s);

describe("breaker rules", () => {
  it("opens_after_consecutive_failures_and_holds_the_queue", () => {
    expect(run(["failure", "failure"]).status).toBe("closed");
    const open = run(["failure", "failure", "failure"], 1000);
    expect(open).toEqual({ status: "open", failures: 3, openedAtMs: 1000 });
    expect(breakerAllows(open, 1000 + 1, cfg)).toBe(false);
  });
  it("reset_releases_the_queue", () => {
    const open = run(["failure", "failure", "failure"]);
    const s = breakerStep(open, "reset", 5, cfg);
    expect(s).toEqual(CLOSED);
    expect(breakerAllows(s, 5, cfg)).toBe(true);
  });
  it("cooldown_elapses_to_half_open_and_success_closes", () => {
    const open = run(["failure", "failure", "failure"], 0);
    expect(breakerAllows(open, 899_999, cfg)).toBe(false);
    expect(breakerAllows(open, 900_000, cfg)).toBe(true);
    const probe = breakerStep(open, "success", 900_000, cfg);
    expect(probe).toEqual(CLOSED);
  });
  it("a failure while half open reopens with a fresh cooldown", () => {
    const open = run(["failure", "failure", "failure"], 0);
    const again = breakerStep(open, "failure", 900_000, cfg);
    expect(again.status).toBe("open");
    expect(again.openedAtMs).toBe(900_000);
    expect(breakerAllows(again, 900_001, cfg)).toBe(false);
  });
  it("a_success_in_between_keeps_it_closed", () => {
    expect(run(["failure", "failure", "success", "failure", "failure"])).toEqual({ status: "closed", failures: 2, openedAtMs: null });
  });
  it("threshold 0 disables the breaker", () => {
    const off = { threshold: 0, cooldownMs: 1 };
    const s = ["failure", "failure", "failure", "failure"].reduce((st) => breakerStep(st, "failure", 0, off), CLOSED as BreakerState);
    expect(breakerAllows(s, 0, off)).toBe(true);
  });
});

describe("breaker admission (half open lets exactly one through)", () => {
  const open = run(["failure", "failure", "failure"], 0);
  it("closed admits without taking a probe; open holds", () => {
    expect(admitBreaker(CLOSED, null, 5, cfg)).toEqual({ allowed: true, takesProbe: false });
    expect(admitBreaker(open, null, 899_999, cfg)).toEqual({ allowed: false, takesProbe: false });
  });
  it("half open admits one probe, then holds until the probe ages out", () => {
    expect(admitBreaker(open, null, 900_000, cfg)).toEqual({ allowed: true, takesProbe: true });
    expect(admitBreaker(open, 900_000, 900_001, cfg)).toEqual({ allowed: false, takesProbe: false });
    expect(admitBreaker(open, 900_000, 1_800_000, cfg)).toEqual({ allowed: true, takesProbe: true });
  });
  it("threshold 0 always admits", () => {
    expect(admitBreaker(open, null, 1, { threshold: 0, cooldownMs: 1 })).toEqual({ allowed: true, takesProbe: false });
  });
  it("holdUntilMs says when the next stage may pass, or null", () => {
    expect(holdUntilMs(CLOSED, null, 0, cfg)).toBeNull();
    expect(holdUntilMs(open, null, 10, cfg)).toBe(900_000);
    expect(holdUntilMs(open, null, 900_000, cfg)).toBeNull();
    expect(holdUntilMs(open, 900_000, 900_100, cfg)).toBe(1_800_000);
  });
});
