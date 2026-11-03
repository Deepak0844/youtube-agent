import { describe, expect, it } from "vitest";
import { DARK_INK, inkOf } from "../../remotion/kit/ink";
import { contrast } from "../../remotion/kit/look";
import { PRESETS, STYLE_IDS } from "../../remotion/kit/presets";
import { defaultTheme } from "../../remotion/kit/theme";

const LIGHT = ["clean_professional", "minimal_diagram", "premium_editorial"] as const;

describe("kit ink", () => {
  it("dark styles and no style keep today's constants exactly", () => {
    for (const id of [...STYLE_IDS.filter((s) => !(LIGHT as readonly string[]).includes(s)), "legacy_default", "neon_flat", "blueprint_whiteboard", "documentary_montage"] as const) {
      expect(inkOf(PRESETS[id])).toBe(DARK_INK);
    }
    expect(DARK_INK).toMatchObject({ text: defaultTheme.palette.text, muted: defaultTheme.palette.muted, surface: defaultTheme.palette.surface, bg: defaultTheme.palette.bg, grid: defaultTheme.palette.gridLine, accent: defaultTheme.palette.accent });
    expect(DARK_INK.chart).toBe(defaultTheme.palette.chart);
  });

  it.each(LIGHT)("%s: light page, dark ink that reads on the page and on cards", (id) => {
    const p = PRESETS[id];
    const ink = inkOf(p);
    expect(p.light).toBe(true);
    expect(p.sheet![0]!.toLowerCase()).toBe(p.palette.bg);
    expect(ink.bg).toBe(p.look!.from);
    for (const c of [ink.text, ink.muted, ink.warn]) {
      expect(contrast(c, ink.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c, ink.surface)).toBeGreaterThanOrEqual(4.5);
    }
    // Accent: large headline words, key marks, chart bars (3:1 for large text and graphics).
    expect(contrast(ink.accent, ink.bg)).toBeGreaterThanOrEqual(3);
    for (const c of ink.chart) expect(contrast(c, ink.bg)).toBeGreaterThanOrEqual(2);
    expect(contrast(ink.grid, ink.bg)).toBeGreaterThanOrEqual(1.4);
    // Caption pill text reads on the page (transparent pill) or on its own pill colour.
    const cs = p.captions;
    if (cs.pillBg === "transparent") expect(contrast(cs.textColor ?? ink.text, ink.bg)).toBeGreaterThanOrEqual(4.5);
  });
});
