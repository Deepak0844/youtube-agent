import { describe, expect, it } from "vitest";
import { fitFont, safeSize } from "../../remotion/kit/layout";
import { theme } from "../../remotion/kit/theme";
import { LIMITS } from "../../src/shared/scene/kinds/common";

describe("kit layout", () => {
  it("safeSize is the frame minus the safe margins", () => {
    expect(safeSize(theme)).toEqual({ w: 936, h: 1320 });
  });

  it("fitFont keeps the max size when everything fits", () => {
    expect(
      fitFont(["hi"], {
        width: 900,
        height: 900,
        min: 28,
        max: 56,
        charW: 0.6,
      }),
    ).toBe(56);
  });

  it("fitFont shrinks, never below min, and result fits when above min", () => {
    const o = {
      width: 936,
      height: 1320,
      min: 28,
      max: 56,
      charW: 0.6,
      lineH: 1.4,
      perItem: 20,
    };
    const worst = Array.from({ length: LIMITS.terminalLines }, () => "x".repeat(LIMITS.terminalPrompt + 1 + LIMITS.terminalText));
    const s = fitFont(worst, o);
    expect(s).toBeGreaterThanOrEqual(28);
    expect(s).toBeLessThanOrEqual(56);
    const huge = Array.from({ length: 50 }, () => "x".repeat(200));
    expect(fitFont(huge, o)).toBe(28);
  });
});
