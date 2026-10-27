import { describe, expect, it } from "vitest";
import { compactLine } from "@/server/core/log-redact";

const bytes = (s: string) => Buffer.byteLength(s);

describe("compactLine", () => {
  it("huge_json_line_is_shrunk_but_stays_valid_json", () => {
    const big = JSON.stringify({ kind: "frame", image: "A".repeat(50_000), list: Array.from({ length: 500 }, (_, i) => ({ i, t: "x".repeat(50) })), keep: "small" });
    const out = compactLine(big, 4096);
    expect(bytes(out)).toBeLessThanOrEqual(4096);
    const parsed = JSON.parse(out);
    expect(parsed.kind).toBe("frame");
  });
  it("base64_payloads_are_replaced", () => {
    const out = compactLine("data:image/png;base64," + "QUJD".repeat(5000));
    expect(bytes(out)).toBeLessThanOrEqual(4096);
    expect(out).not.toContain("QUJDQUJD");
  });
  it("json_with_many_huge_fields_still_fits_and_parses", () => {
    const o: Record<string, string> = {};
    for (let i = 0; i < 400; i++) o["k" + i] = "v".repeat(100);
    const out = compactLine(JSON.stringify(o), 1024);
    expect(bytes(out)).toBeLessThanOrEqual(1024);
    expect(() => JSON.parse(out)).not.toThrow();
  });
  it("plain_long_text_is_cut_on_a_character_boundary", () => {
    const out = compactLine("é".repeat(10_000), 100);
    expect(bytes(out)).toBeLessThanOrEqual(100);
    expect(out).not.toContain("�");
  });
  it("lines_under_the_limit_are_returned_unchanged", () => {
    expect(compactLine('{"a": 1}')).toBe('{"a": 1}');
    expect(compactLine("hello")).toBe("hello");
  });
});
