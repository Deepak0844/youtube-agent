import { describe, expect, it } from "vitest";
import { tsxCaptionsAss } from "@/server/core/tsx-captions";

const W = (word: string, startS: number, endS: number) => ({ word, startS, endS });

describe("tsxCaptionsAss", () => {
  it("pages 3 words at a time, highlights the spoken word and never overlaps pages", () => {
    const ass = tsxCaptionsAss([W("One", 0, 0.4), W("two", 0.4, 0.8), W("three", 0.8, 1.2), W("four", 1.2, 1.6)])!;
    const lines = ass.split("\n").filter((l) => l.startsWith("Dialogue"));
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("0:00:00.00,0:00:00.40,Default");
    expect(lines[0]).toContain("{\\c&H5EE4FF&}One{\\r} two three");
    expect(lines[3]).toContain("{\\c&H5EE4FF&}four{\\r}");
    expect(lines[2]).toContain("0:00:00.80,0:00:01.20"); // ends where page two starts
  });
  it("sits bottom-centre with margin 150 (below y 1497) and strips override braces and backslashes from words", () => {
    const ass = tsxCaptionsAss([W("a{\\b1}b", 0, 1)])!;
    expect(ass).toContain(",2,60,60,150,1");
    expect(ass).toContain("{\\c&H5EE4FF&}ab1b{\\r}");
  });
  it("returns null without usable word times", () => {
    expect(tsxCaptionsAss([])).toBeNull();
    expect(tsxCaptionsAss([W("", 0, 1), W("x", NaN, 1), W("y", 2, 1)])).toBeNull();
  });
});
