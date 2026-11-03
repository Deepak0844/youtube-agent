// yt-kit style data: what a chosen video style means for a Custom animation (TSX) video. Pure (no React, no IO), built from
// remotion/kit/presets.ts (the real `sheet` colours, fonts, motion, pacing, captions). Used by the library (util.ts, layout.tsx,
// stage.tsx), the caption overlay and the prompt (src/server/core/tsx-prompt-style.ts).
import { PRESETS, STYLE_IDS, type CaptionStyle, type StyleId } from "../presets";

export type { StyleId };
export const DEFAULT_TSX_STYLE: StyleId = "ai_studio";

export type BackdropKind = "paper" | "grid" | "glow" | "night" | "gradient";
export const COLOR_KEYS = ["bg", "text", "muted", "surface", "accent", "accent2", "accent3"] as const;
export type StyleColors = Record<(typeof COLOR_KEYS)[number], string>;
export interface TsxStyle {
  id: StyleId;
  label: string;
  colors: StyleColors;
  backdrop: BackdropKind;
  /** The page is light: dark text, no dark shadows. */
  light: boolean;
  fonts: { display: string; body: string; mono: string };
  headingWeight: number;
  /** Headlines in capitals. */
  caps: boolean;
  /** Average glyph width / font size of the heading font, for line wrapping. */
  glyphW: number;
  motion: { stiffness: number; damping: number; frames: number; rise: number; scaleFrom: number; spring: boolean };
  /** Scene hold in frames. */
  pace: { min: number; max: number };
  captions: CaptionStyle;
}

// Per style: [bg, text, accent, accent2, accent3] (all from the owner's `sheet`, plus the preset text colour where the sheet has none),
// the backdrop type, capitals and the heading glyph width. A unit test checks every colour against the sheet.
const EXTRA: Record<StyleId, { c: readonly [string, string, string, string, string]; backdrop: BackdropKind; caps?: boolean; glyphW?: number }> = {
  clean_professional: { c: ["#FFFFFF", "#1F2937", "#2563EB", "#F59E0B", "#2563EB"], backdrop: "paper" },
  flat_motion: { c: ["#0F172A", "#F8FAFC", "#7C3AED", "#EC4899", "#22D3EE"], backdrop: "gradient" },
  minimal_diagram: { c: ["#FAFAFA", "#1A1A2E", "#E94560", "#E94560", "#E94560"], backdrop: "grid" },
  premium_editorial: { c: ["#F9FAFB", "#111827", "#2563EB", "#0D9488", "#2563EB"], backdrop: "paper" },
  storybook_calm: { c: ["#0A0A1A", "#F5F0E8", "#FFB347", "#2F6B4F", "#FFB347"], backdrop: "night" },
  paper_cutout: { c: ["#132124", "#DACEC0", "#D67354", "#C9573C", "#2DA34D"], backdrop: "paper", caps: true, glyphW: 0.74 },
  kinetic_type: { c: ["#0B0B0F", "#FFFFFF", "#FFE45E", "#FF4D6D", "#FFE45E"], backdrop: "paper", caps: true, glyphW: 0.74 },
  retention_shorts: { c: ["#111827", "#FFFFFF", "#FFE45E", "#1D4ED8", "#000000"], backdrop: "gradient", caps: true },
  wrapped_stats: { c: ["#0B1020", "#FFFFFF", "#FDE047", "#F472B6", "#34D399"], backdrop: "gradient" },
  ai_studio: { c: ["#0E1226", "#FFFFFF", "#F5D76E", "#6366F1", "#4DB8A8"], backdrop: "glow", caps: true },
};

const hex = (c: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) as [number, number, number];
const toHex = (v: readonly number[]): string => "#" + v.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0")).join("");
/** Mix of two #rrggbb colours: a at 1-p, b at p. */
export function mixHex(a: string, b: string, p: number): string {
  const x = hex(a);
  const y = hex(b);
  return toHex(x.map((v, i) => v + (y[i]! - v) * p));
}
const lin = (v: number): number => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
/** WCAG relative luminance of #rrggbb. */
export const luminance = (c: string): number => {
  const [r, g, b] = hex(c);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
/** WCAG contrast ratio (1 to 21) of two #rrggbb colours. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const stack = (name: string): string => `"${name}", ${/Serif|Fraunces|Spectral/.test(name) ? "serif" : "sans-serif"}`;

function build(id: StyleId): TsxStyle {
  const p = PRESETS[id];
  const e = EXTRA[id];
  const [bg, text, accent, accent2, accent3] = e.c;
  const m = p.motion;
  return {
    id,
    label: p.label,
    colors: { bg, text, muted: mixHex(bg, text, 0.68), surface: mixHex(bg, text, 0.08), accent, accent2, accent3 },
    backdrop: e.backdrop,
    light: luminance(bg) > 0.5,
    fonts: { display: stack(p.fonts.heading), body: stack(p.fonts.body), mono: stack(p.fonts.mono ?? "JetBrains Mono") },
    headingWeight: p.fonts.headingWeight,
    caps: e.caps ?? false,
    glyphW: e.glyphW ?? 0.64,
    // A smooth style has no spring in the preset: give it a critically damped one (no overshoot) so MOTION is always usable.
    motion: { stiffness: m.kind === "spring" ? m.stiffness : 100, damping: m.kind === "spring" ? m.damping : 24, frames: m.transitionFrames, rise: m.rise, scaleFrom: m.scaleFrom ?? 1, spring: m.kind === "spring" },
    pace: { min: p.pacing.minHoldFrames, max: p.pacing.maxHoldFrames },
    captions: p.captions,
  };
}

const CACHE = new Map<StyleId, TsxStyle>();
/** True for the ten picker ids (legacy ids are not styles of a code scene). */
export const isTsxStyleId = (v: unknown): v is StyleId => typeof v === "string" && (STYLE_IDS as readonly string[]).includes(v);
/** The style data for an id; anything unknown (or null) is the AI Studio look. */
export function tsxStyleOf(id: unknown): TsxStyle {
  const k = isTsxStyleId(id) ? id : DEFAULT_TSX_STYLE;
  let s = CACHE.get(k);
  if (!s) {
    s = build(k);
    CACHE.set(k, s);
  }
  return s;
}

// The style of THIS render. A render is one video with one style, set once (style.ts, tsx-root.tsx) before any scene code reads
// PALETTE / FONTS / MOTION / PACE. Model code never touches this: it can only read those exports.
let active: TsxStyle = tsxStyleOf(DEFAULT_TSX_STYLE);
export const getActiveStyle = (): TsxStyle => active;
export const setActiveStyle = (id: unknown): TsxStyle => (active = tsxStyleOf(id));
