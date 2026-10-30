import { describe, expect, it } from "vitest";
import { emphasisStyle, enterProgress, enterStyle, networkLayout, objectRows, packetT } from "../../remotion/kit/drawnHelpers";
import { theme } from "../../remotion/kit/theme";

describe("drawn helpers", () => {
  it("objectRows stays inside the safe area for 1..4 objects", () => {
    for (let n = 1; n <= 4; n++) {
      const { ys, rowH } = objectRows(n, "center");
      expect(ys).toHaveLength(n);
      expect(ys[0]! - rowH / 2).toBeGreaterThanOrEqual(theme.safe.top);
      expect(ys[n - 1]! + rowH / 2).toBeLessThanOrEqual(theme.height - theme.safe.bottom);
    }
    expect(objectRows(1, "left").x).toBeLessThan(objectRows(1, "right").x);
  });
  it("enter progress staggers and clamps", () => {
    expect(enterProgress(0, 0)).toBe(0);
    expect(enterProgress(12, 0)).toBe(1);
    expect(enterProgress(8, 1)).toBe(0);
    expect(enterStyle("slide_up", 0).dy).toBe(80);
    expect(enterStyle("pop", 1)).toEqual({ opacity: 1, scale: 1, dy: 0 });
  });
  it("emphasis none is still, others move", () => {
    expect(emphasisStyle("none", 7)).toEqual({ scale: 1, rot: 0 });
    expect(emphasisStyle("pulse", 7).scale).not.toBe(1);
    expect(emphasisStyle("wiggle", 4).rot).not.toBe(0);
  });
  it("network layout fits the safe area and packets run link by link", () => {
    for (const p of networkLayout(6)) {
      expect(p.y).toBeGreaterThanOrEqual(theme.safe.top);
      expect(p.y).toBeLessThanOrEqual(theme.height - theme.safe.bottom);
      expect(p.x).toBeGreaterThan(theme.safe.side + 150);
      expect(p.x).toBeLessThan(theme.width - theme.safe.side - 150);
    }
    expect(packetT(10, 0, 2, 100)).toBeGreaterThan(0);
    expect(packetT(10, 1, 2, 100)).toBe(-1);
    expect(packetT(60, 1, 2, 100)).toBeGreaterThan(0);
    expect(packetT(99, 1, 2, 100)).toBe(-1);
  });
});
