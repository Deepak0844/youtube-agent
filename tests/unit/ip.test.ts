import { describe, expect, it } from "vitest";
import { normalizeIp } from "@/server/core/ip";

describe("normalizeIp", () => {
  it.each([
    ["1.2.3.4", "1.2.3.4"],
    [" 1.2.3.4 ", "1.2.3.4"],
    ["::FFFF:1.2.3.4", "1.2.3.4"],
    ["::ffff:1.2.3.4", "1.2.3.4"],
    ["::ffff:102:304", "1.2.3.4"],
    ["::FFFF:0102:0304", "1.2.3.4"],
    ["FE80::1%eth0", "fe80::1"],
    ["2001:DB8::1", "2001:db8::1"],
    ["", "unknown"],
    ["   ", "unknown"],
    ["%eth0", "unknown"],
    [undefined, "unknown"],
    [null, "unknown"],
    [42, "unknown"],
    [{}, "unknown"],
  ])("normalise_ip %j -> %s", (input, out) => {
    expect(normalizeIp(input)).toBe(out);
  });
  it("truncates_after_normalising", () => {
    expect(normalizeIp("A".repeat(200))).toBe("a".repeat(64));
    expect(normalizeIp("   " + "b".repeat(100))).toBe("b".repeat(64));
  });
});
