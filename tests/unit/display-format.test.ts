import { describe, expect, it } from "vitest";
import { DEFAULT_INR_RATE, formatIst, formatMoney } from "@/server/core/display-format";
import { SETTINGS } from "@/server/core/settings-registry";

describe("formatMoney", () => {
  it("shows dollars and rupees at the default rate", () => {
    expect(formatMoney(1_230_000, DEFAULT_INR_RATE)).toBe("$1.23 (₹116.9)");
    expect(formatMoney(0, DEFAULT_INR_RATE)).toBe("$0.00 (₹0.0)");
  });
  it("follows a changed rate and groups lakhs", () => {
    expect(formatMoney(1_000_000, 100)).toBe("$1.00 (₹100.0)");
    expect(formatMoney(2_000_000_000, 95.05)).toBe("$2000.00 (₹1,90,100.0)");
    expect(formatMoney(1_234_567_890, 83.5)).toBe("$1234.57 (₹1,03,086.4)");
  });
  it("rounds to cents and to one rupee decimal", () => {
    expect(formatMoney(4_996_000, 95.05)).toBe("$5.00 (₹474.9)");
    expect(formatMoney(3_500, 95.05)).toBe("$0.00 (₹0.3)");
  });
  it("falls back to dollars only without a usable rate", () => {
    for (const r of [null, undefined, 0, -1, NaN, Infinity]) expect(formatMoney(1_230_000, r)).toBe("$1.23");
  });
});

describe("formatIst", () => {
  it("adds 5h30", () => {
    expect(formatIst(new Date("2026-03-04T05:06:07Z"))).toBe("2026-03-04 10:36 IST");
    expect(formatIst(new Date("2026-03-04T05:06:07Z"), true)).toBe("2026-03-04 10:36:07 IST");
  });
  it("rolls the date over across midnight", () => {
    expect(formatIst(new Date("2026-12-31T18:29:59Z"))).toBe("2026-12-31 23:59 IST");
    expect(formatIst(new Date("2026-12-31T18:30:00Z"))).toBe("2027-01-01 00:00 IST");
  });
});

describe("display.inr_rate setting", () => {
  it("defaults to 95.05 and accepts only positive numbers", () => {
    const s = SETTINGS["display.inr_rate"];
    expect(s.default).toBe(95.05);
    expect(s.safety).toBe(false);
    expect(s.schema.safeParse(83.2).success).toBe(true);
    for (const bad of [0, -5, "95", NaN, Infinity, 10_001]) expect(s.schema.safeParse(bad).success).toBe(false);
  });
});
