import { describe, expect, it } from "vitest";
import { THEME_COOKIE, parseTheme, themeScript } from "@/ui/theme";

describe("theme choice", () => {
  it("reads the three choices", () => {
    expect(parseTheme("dark")).toBe("dark");
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("system")).toBe("system");
  });
  it("anything else is system", () => {
    expect(parseTheme("x")).toBe("system");
    expect(parseTheme(undefined)).toBe("system");
  });
  it("the head script only reads our cookie and only sets light or dark", () => {
    expect(THEME_COOKIE).toBe("ytstudio-theme");
    expect(themeScript).toContain(THEME_COOKIE);
    expect(themeScript).toContain("(light|dark)");
    expect(themeScript).not.toMatch(/innerHTML|eval|fetch/);
  });
});
