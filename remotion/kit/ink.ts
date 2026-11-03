// Colours kit pieces paint text, cards and lines with. Dark styles (and no style) use today's constants; light styles swap in dark ink on paper.
// Plain data (no React) so it is unit-tested.
import { theme } from "./theme";
import type { StylePreset } from "./presets";

export type Ink = {
  text: string;
  muted: string;
  /** Cards, cells, bubbles. */
  surface: string;
  /** The page colour; text sitting on an accent fill. */
  bg: string;
  grid: string;
  accent: string;
  chart: readonly string[];
  /** Option rows / chips laid on the page. */
  chip: string;
  /** Soft shadow under photos. */
  shadow: string;
  /** Behind a photo that does not fill the frame. */
  photoBlur: string;
  /** Packet / warning text that sits on a card. */
  warn: string;
};

/** Today's values, exactly. */
export const DARK_INK: Ink = {
  text: theme.palette.text,
  muted: theme.palette.muted,
  surface: theme.palette.surface,
  bg: theme.palette.bg,
  grid: theme.palette.gridLine,
  accent: theme.palette.accent,
  chart: theme.palette.chart,
  chip: "rgba(0,0,0,0.35)",
  shadow: "0 18px 48px rgba(0,0,0,0.55)",
  photoBlur: "blur(40px) brightness(0.45)",
  warn: theme.art.warn,
};

/** The ink for a style: only light styles override (dark ink on the style's own paper colours). */
export const inkOf = (preset: StylePreset): Ink =>
  preset.light
    ? {
        text: preset.palette.text,
        muted: preset.palette.muted,
        surface: preset.palette.surface,
        bg: preset.palette.bg,
        grid: "#c4cad4",
        accent: preset.palette.accent,
        chart: preset.palette.chart,
        chip: "rgba(17,24,39,0.07)",
        shadow: "0 18px 48px rgba(17,24,39,0.2)",
        photoBlur: "blur(40px) brightness(1.05) saturate(0.7)",
        warn: "#92400e",
      }
    : DARK_INK;
