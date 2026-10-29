import { describe, expect, it } from "vitest";
import { capAllows } from "@/server/core/spend";

describe("capAllows", () => {
  it("a null cap (no limit) always allows, however much is wanted", () => {
    expect(capAllows(null, 0n, 0n, 0n)).toBe(true);
    expect(capAllows(null, 10n ** 15n, 10n ** 15n, 10n ** 15n)).toBe(true);
  });

  it("no_limit_is_not_zero: a cap of 0 refuses any positive amount and allows zero", () => {
    expect(capAllows(0n, 0n, 0n, 1n)).toBe(false);
    expect(capAllows(0n, 0n, 0n, 0n)).toBe(true);
  });

  it("allows exactly up to the cap and refuses one more", () => {
    expect(capAllows(100n, 40n, 30n, 30n)).toBe(true);
    expect(capAllows(100n, 40n, 30n, 31n)).toBe(false);
  });

  it("counts spent and reserved both", () => {
    expect(capAllows(100n, 100n, 0n, 1n)).toBe(false);
    expect(capAllows(100n, 0n, 100n, 1n)).toBe(false);
  });
});

import { dollarsToMicro, microToDollars } from "@/server/core/spend";

describe("dollars and micro-USD", () => {
  it("parses whole and fractional dollars", () => {
    expect(dollarsToMicro("2")).toBe(2_000_000);
    expect(dollarsToMicro(" 2.50 ")).toBe(2_500_000);
    expect(dollarsToMicro("0.0035")).toBe(3_500);
    expect(dollarsToMicro("0")).toBe(0);
  });
  it.each(["", "-1", "1e3", "2,5", "1.2345678", ".5", "abc", "NaN", "12345678"])("refuses %j", (t) => {
    expect(dollarsToMicro(t)).toBeNull();
  });
  it("shows exact figures and never rounds a real cap down to $0.00", () => {
    expect(microToDollars(2_000_000)).toBe("$2.00");
    expect(microToDollars(3_500)).toBe("$0.0035");
    expect(microToDollars(0)).toBe("$0.00");
    expect(microToDollars(1_234_500_000)).toBe("$1,234.50");
  });
});
