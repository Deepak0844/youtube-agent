import { describe, expect, it } from "vitest";
import { makeProgressThrottle } from "@/server/core/stage-handler";

describe("makeProgressThrottle", () => {
  it("writes the first value, skips unchanged and too-soon values", () => {
    let t = 0;
    const out: number[] = [];
    const p = makeProgressThrottle((n) => out.push(n), () => t);
    p(5); // first: written
    t = 500; p(6); // too soon
    t = 2000; p(5.4); // same whole percent as last written
    t = 2100; p(7); // changed and >= 2 s since last write
    t = 4100; p(7); // unchanged
    t = 4200; p(150); // clamped to 100
    t = 6200; p(Number.NaN); // ignored
    expect(out).toEqual([5, 7, 100]);
  });
});
