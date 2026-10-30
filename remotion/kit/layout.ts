// Pure layout helpers (unit-tested; no Remotion imports). Sizes are estimates from average glyph width, so keep a little slack.
import type { BrandTheme } from "./theme";

/** Width and height (px) of the area inside the safe margins. */
export const safeSize = (t: Pick<BrandTheme, "width" | "height" | "safe">) => ({
  w: t.width - 2 * t.safe.side,
  h: t.height - t.safe.top - t.safe.bottom,
});

/**
 * Largest font size in [min, max] (steps of 2) at which `texts`, wrapped to `width`, stack within `height`.
 * `charW` is the average glyph width in em, `perItem` the fixed px added per text (padding, gaps). Falls back to `min`.
 */
export function fitFont(
  texts: string[],
  o: {
    width: number;
    height: number;
    min: number;
    max: number;
    charW: number;
    lineH?: number;
    perItem?: number;
  },
): number {
  const lineH = o.lineH ?? 1.3;
  const need = (s: number) => texts.reduce((h, x) => h + Math.max(1, Math.ceil(([...x].length * s * o.charW) / o.width)) * s * lineH + (o.perItem ?? 0), 0);
  for (let s = o.max; s > o.min; s -= 2) if (need(s) <= o.height) return s;
  return o.min;
}
