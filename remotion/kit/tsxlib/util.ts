// yt-kit helpers (pure). Part of the TSX library ("yt-kit") that model-written scenes import; see ./index.ts.
//
// Adapted from the claude-faceless-shorts-creator kit (lib/shorts.tsx, lib/electric.tsx).
// MIT License, Copyright (c) 2026 Hasan Aboul Hasan. The full notice is in THIRD_PARTY_NOTICES.md.
//
// SECURITY: this file turns untrusted prop values into safe ones: numbers are clamped (NaN and Infinity fall back),
// colours must be #hex, rgb()/rgba() with plain numbers, or a palette name; anything else becomes the fallback colour.
// Nothing in yt-kit builds a URL, HTML or a style string from a free-form prop.
import React from "react";
import { Easing } from "remotion";
import { COLOR_KEYS, getActiveStyle } from "./styledata";

export const W = 1080;
export const H = 1920;

/** Brand colours that never change with the style (kept so older scenes and names keep working). */
const BRAND = {
  indigo: "#6366F1",
  violet: "#9b7cc4",
  teal: "#4db8a8",
  yellow: "#f5d76e",
  pink: "#e8879f",
  ink: "#1a1a2e",
  white: "#ffffff",
  cyan: "#4ecdc4",
  blue: "#5b8def",
  red: "#e8586f",
  orange: "#ff9a52",
} as const;
export const FONT_DISPLAY = '"Space Grotesk", "Inter", sans-serif';
export const FONT_BODY = '"Inter", "Space Grotesk", sans-serif';
export const FONT_MONO = '"JetBrains Mono", monospace';

// PALETTE, FONTS, MOTION and PACE are objects of getters: each read gives the value of the ACTIVE style (styledata.ts), which the
// host sets once per render. The scene checker only allows reads like PALETTE.accent, so model code cannot hold or change them.
function live<T extends object>(keys: readonly string[], read: (k: string) => unknown): T {
  const o = {} as Record<string, unknown>;
  for (const k of keys) Object.defineProperty(o, k, { enumerable: true, get: () => read(k) });
  return o as T;
}
/** Colour names: the style's bg text muted surface accent accent2 accent3, plus the fixed brand names (indigo violet teal ...). */
export const PALETTE: Readonly<Record<string, string>> = live([...Object.keys(BRAND), ...COLOR_KEYS], (k) => (k in BRAND ? BRAND[k as keyof typeof BRAND] : getActiveStyle().colors[k as (typeof COLOR_KEYS)[number]]));
/** Font stacks, as one object (the scene checker allows an imported object only through member access: FONTS.mono). */
export const FONTS = live<{ display: string; body: string; mono: string }>(["display", "body", "mono"], (k) => getActiveStyle().fonts[k as "display"]);
/** Motion numbers of the style: spring stiffness and damping, transition length and rise in px, start scale. */
export const MOTION = live<{ stiffness: number; damping: number; frames: number; rise: number; scaleFrom: number }>(["stiffness", "damping", "frames", "rise", "scaleFrom"], (k) => getActiveStyle().motion[k as "frames"]);
/** Scene hold of the style in frames: min and max. */
export const PACE = live<{ min: number; max: number }>(["min", "max"], (k) => getActiveStyle().pace[k as "min"]);

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB = /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d{1,3})\s*)?\)$/i;

/** A colour that is safe to put in a style: #hex, rgb()/rgba() or a palette name; otherwise the fallback. */
export function safeColor(c: unknown, fallback: string = PALETTE.yellow!): string {
  if (typeof c !== "string") return fallback;
  const t = c.trim();
  if (HEX.test(t) || RGB.test(t)) return t;
  const key = t.toLowerCase();
  return Object.prototype.hasOwnProperty.call(PALETTE, key) ? PALETTE[key]! : fallback;
}

/** A finite number inside [lo, hi]; anything else (undefined, NaN, a string) gives the fallback. */
export function num(v: unknown, lo: number, hi: number, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;
}

/** Text for a text node: a string cut to max characters, or "". Never markup: React escapes it. */
export function txt(v: unknown, max = 80): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

/** Wraps a drawing component so every number prop is finite and within +-100000 (NaN and Infinity become 0) before it is drawn. */
export function saneNumbers<P extends object>(C: React.FC<P>): React.FC<P> {
  const Wrapped: React.FC<P> = (p) => {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(p)) clean[k] = typeof v === "number" ? num(v, -1e5, 1e5, 0) : v;
    return React.createElement(C, clean as P);
  };
  return Wrapped;
}

export const EASE_OUT =Easing.bezier(0.33, 1, 0.68, 1);
export const EASE_INOUT = Easing.bezier(0.37, 0, 0.63, 1);

/** 0..1 progress of t through [a, b], clamped; a degenerate range is safe. */
export const prog = (t: number, a: number, b: number): number => Math.max(0, Math.min(1, (t - a) / Math.max(0.0001, b - a)));
/** Linear mix of a and b by p. */
export const mix = (a: number, b: number, p: number): number => a + (b - a) * p;
/** Eased 0..1 ramp from frame a to frame b. */
export const ramp = (f: number, a: number, b: number): number => EASE_INOUT(prog(f, a, b));
/** Opacity window: eased in over [a0, a1], eased out over [b0, b1]. */
export const win = (f: number, a0: number, a1: number, b0: number, b1: number): number => ramp(f, a0, a1) * (1 - ramp(f, b0, b1));
/** Radians of k whole cycles between frame 0 and frame `total` (a phase that repeats exactly). */
export const cycle = (f: number, total: number, k = 1): number => (2 * Math.PI * k * f) / Math.max(1, total);

export type Pt = readonly [number, number];

/** Point at fraction u (wraps) along a polyline. */
export function polyAt(pts: readonly Pt[], u: number): [number, number] {
  const first = pts[0] ?? [0, 0];
  const last = pts[pts.length - 1] ?? first;
  const seg = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i]![0], p[1] - pts[i]![1]));
  const total = seg.reduce((a, b) => a + b, 0);
  let d = (((u % 1) + 1) % 1) * total;
  for (let i = 0; i < seg.length; i++) {
    const s = seg[i]!;
    if (d <= s) {
      const k = s === 0 ? 0 : d / s;
      return [pts[i]![0] + (pts[i + 1]![0] - pts[i]![0]) * k, pts[i]![1] + (pts[i + 1]![1] - pts[i]![1]) * k];
    }
    d -= s;
  }
  return [last[0], last[1]];
}

/** "M x y L x y ..." for a polyline (numbers only, clamped). */
export const polyD = (pts: readonly Pt[]): string => pts.map((p, i) => `${i ? "L" : "M"}${num(p[0], -1e5, 1e5, 0)} ${num(p[1], -1e5, 1e5, 0)}`).join(" ");

/** 1234567 -> "1,234,567". */
export function fmt(v: number): string {
  const s = String(Math.round(num(v, -1e15, 1e15, 0)));
  const neg = s.startsWith("-");
  const digits = neg ? s.slice(1) : s;
  let out = "";
  for (let i = 0; i < digits.length; i++) out += (i > 0 && (digits.length - i) % 3 === 0 ? "," : "") + digits[i];
  return (neg ? "-" : "") + out;
}

/**
 * Rotor angle in degrees at `frame`. The speed (degrees per frame) follows `keys` ([frame, speed] pairs, linear between them),
 * the angle is the running sum, and over the last 60 frames of `total` it eases onto the next multiple of `sym`
 * (use 360 / number of blades) so the LAST frame looks exactly like frame 0 (angle 0).
 */
export function rotorAngle(frame: number, total: number, keys: readonly Pt[], sym: number): number {
  const T = Math.round(num(total, 2, 2700, 2));
  const f = Math.round(num(frame, 0, T, 0));
  const step = num(sym, 1, 360, 45);
  const speed = (g: number): number => {
    const first = keys[0];
    if (!first || g <= first[0]) return first ? first[1] : 0;
    for (let i = 1; i < keys.length; i++) {
      const a = keys[i - 1]!;
      const b = keys[i]!;
      if (g <= b[0]) return mix(a[1], b[1], (g - a[0]) / Math.max(1e-6, b[0] - a[0]));
    }
    return keys[keys.length - 1]![1];
  };
  let end = 0;
  let at = 0;
  for (let g = 1; g < T; g++) {
    end += speed(g);
    if (g === f) at = end;
  }
  if (f >= T) at = end;
  const target = Math.ceil(end / step) * step;
  return at + (target - end) * EASE_INOUT(prog(f, T - 60, T - 1));
}

/** A faint version of a colour for borders: #rrggbb gets an alpha suffix; any other accepted form (rgb(), #abc, ...) gets a neutral translucent white. */
export const faint = (c: string, alphaHex = "55"): string => (/^#[0-9a-f]{6}$/i.test(c) ? c + alphaHex : "rgba(255,255,255,0.3)");
