import { describe, expect, it } from "vitest";
import { checkCopy, defaultTheme, defineTheme } from "../../remotion/kit/theme";

describe("kit theme", () => {
  it("defineTheme() equals the default", () => {
    expect(defineTheme()).toEqual(defaultTheme);
  });
  it("a custom theme changes a colour and an easing without code changes", () => {
    const t = defineTheme({ palette: { accent: "#ff0066" }, easings: { easeOut: [0.2, 0.9, 0.3, 1] } });
    expect(t.palette.accent).toBe("#ff0066");
    expect(t.palette.bg).toBe(defaultTheme.palette.bg);
    expect(t.easings.easeOut).toEqual([0.2, 0.9, 0.3, 1]);
    expect(t.easings.easeIn).toEqual(defaultTheme.easings.easeIn);
    expect(defaultTheme.palette.accent).toBe("#5eead4");
  });
  it("rejects bad values and unknown keys", () => {
    expect(() => defineTheme({ palette: { accent: "teal" } })).toThrow(/palette.accent/);
    expect(() => defineTheme({ easings: { easeOut: [2, 0, 0, 1] } })).toThrow(/easings.easeOut/);
    expect(() => defineTheme({ safe: { top: 1800 } })).toThrow(/safe/);
    expect(() => defineTheme({ nope: 1 } as never)).toThrow(/unknown key/);
  });
  it("checkCopy flags long lines, too many lines and CTA outros", () => {
    expect(checkCopy("ship it today")).toEqual([]);
    expect(checkCopy("x".repeat(40))).toHaveLength(1);
    expect(checkCopy("a\nb\nc\nd")).toHaveLength(1);
    expect(checkCopy("Like and Subscribe!")).not.toEqual([]);
    expect(checkCopy("subscribe", defineTheme({ copy: { bannedPhrases: [] } }))).toEqual([]);
  });
});
