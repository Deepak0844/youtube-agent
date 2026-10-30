import { describe, expect, it } from "vitest";
import { kenBurns, typedChars, visibleCount } from "../../remotion/kit/helpers";

describe("kit helpers", () => {
  it("visibleCount reveals one item per interval and clamps", () => {
    expect(visibleCount(0, 30, 3)).toBe(1);
    expect(visibleCount(30, 30, 3)).toBe(2);
    expect(visibleCount(999, 30, 3)).toBe(3);
    expect(visibleCount(5, 30, 3, 10)).toBe(0);
  });
  it("typedChars types and clamps", () => {
    expect(typedChars(0, 0, 2, 5)).toBe(0);
    expect(typedChars(4, 0, 2, 5)).toBe(2);
    expect(typedChars(100, 0, 2, 5)).toBe(5);
    expect(typedChars(1, 10, 2, 5)).toBe(0);
  });
  it("kenBurns goes from start to end values", () => {
    const k = { zoomFrom: 1, zoomTo: 1.2, panX: 0.1, panY: 0 };
    expect(kenBurns(0, 100, k)).toEqual({ scale: 1, x: -0.1, y: -0 });
    const end = kenBurns(99, 100, k);
    expect(end.scale).toBeCloseTo(1.2);
    expect(end.x).toBeCloseTo(0.1);
  });
});
