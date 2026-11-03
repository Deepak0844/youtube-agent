// yt-kit page pieces: canvas, backdrop, title, kicker, captions, progress bar, chip, callout, counter.
// All are frame-driven (useCurrentFrame only), take text as plain strings and colours through safeColor().
//
// Adapted from the claude-faceless-shorts-creator kit (lib/shorts.tsx, the Short19 chip/backdrop helpers).
// MIT License, Copyright (c) 2026 Hasan Aboul Hasan. The full notice is in THIRD_PARTY_NOTICES.md.
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { cycle, EASE_OUT, faint, FONT_BODY, FONT_DISPLAY, FONT_MONO, fmt, H, num, PALETTE, prog, safeColor, txt, W } from "./util";

/** Eased fade/slide-in at frame `at`, optional fade-out ending at `until`. 0..1. */
const appear = (f: number, at: number, until?: number): number => {
  const a = num(at, 0, 1e5, 0);
  const inn = EASE_OUT(prog(f, a, a + 10));
  return until === undefined ? inn : inn * (1 - prog(f, num(until, 0, 1e5, 0) - 8, num(until, 0, 1e5, 0)));
};

export const KitDefs: React.FC = () => (
  <defs>
    <linearGradient id="yk-steel" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor="#e4eaf2" />
      <stop offset="0.5" stopColor="#9aa7ba" />
      <stop offset="1" stopColor="#4d596d" />
    </linearGradient>
    <linearGradient id="yk-copper" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stopColor="#f0b27a" />
      <stop offset="1" stopColor="#b5642c" />
    </linearGradient>
    <radialGradient id="yk-glass" cx="0.5" cy="0.45" r="0.6">
      <stop offset="0" stopColor="#ffffff" />
      <stop offset="0.45" stopColor="#fff1a8" />
      <stop offset="1" stopColor="#f5b942" />
    </radialGradient>
    <radialGradient id="yk-halo" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stopColor="#ffe48a" stopOpacity="0.85" />
      <stop offset="0.5" stopColor="#f5d76e" stopOpacity="0.25" />
      <stop offset="1" stopColor="#f5d76e" stopOpacity="0" />
    </radialGradient>
    <linearGradient id="yk-redmag" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stopColor="#ff8a9b" />
      <stop offset="1" stopColor="#c23a55" />
    </linearGradient>
    <linearGradient id="yk-bluemag" x1="1" y1="0" x2="0" y2="0">
      <stop offset="0" stopColor="#8fb4ff" />
      <stop offset="1" stopColor="#3558c2" />
    </linearGradient>
    <linearGradient id="yk-water" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor="#5fc4ff" />
      <stop offset="1" stopColor="#1c63b8" />
    </linearGradient>
    <linearGradient id="yk-cell" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stopColor="#2d4a9c" />
      <stop offset="1" stopColor="#14235c" />
    </linearGradient>
    <linearGradient id="yk-concrete" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stopColor="#c8ced8" />
      <stop offset="1" stopColor="#8a93a3" />
    </linearGradient>
    <radialGradient id="yk-sun" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stopColor="#fff6c2" />
      <stop offset="0.55" stopColor="#ffd45a" />
      <stop offset="1" stopColor="#ffb02e" stopOpacity="0" />
    </radialGradient>
    <filter id="yk-shadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="10" stdDeviation="12" floodColor="#000000" floodOpacity="0.35" />
    </filter>
  </defs>
);

/** The persistent 1080x1920 drawing surface: one svg with the shared gradients. Put every drawn prop inside it. */
export const Canvas: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: "absolute", left: 0, top: 0 }}>
    <KitDefs />
    {children}
  </svg>
);

/** Dark stage with a vignette and slow brand-coloured glows. The glows repeat exactly, so the last frame equals frame 0. */
export const Backdrop: React.FC<{ base?: string; glow?: string }> = ({ base = "#0b1020", glow = "#1a2650" }) => {
  const f = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const a = cycle(f, durationInFrames - 1);
  const blob = (cx: number, cy: number, r: number, color: string, k: number, ph: number, amp: number) => (
    <div style={{ position: "absolute", left: cx + Math.sin(a * k + ph) * amp - r, top: cy + Math.cos(a * k + ph) * amp - r, width: r * 2, height: r * 2, borderRadius: "50%", background: `radial-gradient(circle, ${color} 0%, transparent 68%)` }} />
  );
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ background: safeColor(base, "#0b1020") }} />
      <AbsoluteFill style={{ background: `radial-gradient(ellipse 90% 55% at 50% 42%, ${safeColor(glow, "#1a2650")} 0%, transparent 70%)` }} />
      <AbsoluteFill style={{ pointerEvents: "none" }}>
        {blob(200, 380, 520, "rgba(99,102,241,0.26)", 2, 0, 90)}
        {blob(900, 900, 560, "rgba(155,124,196,0.18)", 3, 2, 80)}
        {blob(300, 1500, 520, "rgba(77,184,168,0.20)", 2, 4, 100)}
        <AbsoluteFill style={{ backgroundImage: "radial-gradient(rgba(255,255,255,0.07) 1.5px, transparent 1.6px)", backgroundSize: "54px 54px", opacity: 0.6 }} />
      </AbsoluteFill>
      <AbsoluteFill style={{ background: "radial-gradient(ellipse 120% 90% at 50% 50%, transparent 55%, rgba(0,0,0,0.55) 100%)" }} />
    </AbsoluteFill>
  );
};

/** Hook headline: up to 3 lines (each with its own colour) and an optional subtitle, fully drawn on every frame. */
export const BigTitle: React.FC<{ lines: readonly { text: string; color?: string }[]; subtitle?: string; y?: number; size?: number; opacity?: number }> = ({ lines, subtitle, y = 170, size = 90, opacity = 1 }) => {
  const sz = num(size, 40, 140, 90);
  return (
    <div style={{ position: "absolute", top: num(y, 0, 1500, 170), left: 40, right: 40, textAlign: "center", opacity: num(opacity, 0, 1, 1) }}>
      {lines.slice(0, 3).map((l, i) => (
        <div key={i} style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: sz, lineHeight: 1.06, textTransform: "uppercase", letterSpacing: 1, color: safeColor(l.color, "#ffffff"), textShadow: "0 4px 30px rgba(0,0,0,0.6)" }}>
          {txt(l.text, 40)}
        </div>
      ))}
      {subtitle ? <div style={{ marginTop: 18, fontFamily: FONT_BODY, fontWeight: 500, fontSize: 40, color: "rgba(255,255,255,0.82)" }}>{txt(subtitle, 60)}</div> : null}
    </div>
  );
};

/** Small label pill at the top; fades in at frame `at` and (optionally) out ending at frame `until`. */
export const Kicker: React.FC<{ text: string; color?: string; y?: number; at?: number; until?: number }> = ({ text, color = "yellow", y = 185, at = 0, until }) => {
  const f = useCurrentFrame();
  const o = appear(f, at, until);
  const c = safeColor(color);
  if (o <= 0.01) return null;
  return (
    <div style={{ position: "absolute", top: num(y, 0, 1500, 185), left: 0, right: 0, display: "flex", justifyContent: "center", opacity: o, transform: `translateY(${(1 - o) * 12}px)` }}>
      <div style={{ fontFamily: FONT_BODY, fontWeight: 600, fontSize: 30, letterSpacing: 6, textTransform: "uppercase", color: c, border: `2px solid ${faint(c)}`, borderRadius: 999, padding: "12px 30px", background: "rgba(0,0,0,0.35)" }}>{txt(text, 32)}</div>
    </div>
  );
};

/** Thin bar along the top edge that fills over the whole video. */
export const ProgressBar: React.FC<{ color?: string }> = ({ color = "yellow" }) => {
  const f = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  return (
    <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 6, background: "rgba(255,255,255,0.12)" }}>
      <div style={{ width: `${(f / Math.max(1, durationInFrames - 1)) * 100}%`, height: "100%", background: safeColor(color) }} />
    </div>
  );
};

export type CaptionWord = { w: string; at: number };

/**
 * Karaoke captions: words (with the frame each one starts) shown `maxWords` at a time, the spoken word in the accent colour.
 * `y` is the vertical centre; the default sits in the bottom safe zone (below y = 1420), where nothing else should be.
 */
export const Captions: React.FC<{ words: readonly CaptionWord[]; y?: number; size?: number; accent?: string; maxWords?: number }> = ({ words, y = 1560, size = 58, accent = "yellow", maxWords = 4 }) => {
  const f = useCurrentFrame();
  const per = Math.round(num(maxWords, 1, 8, 4));
  const sz = num(size, 30, 90, 58);
  const list = words.slice(0, 600).map((x) => ({ w: txt(x.w, 24), at: num(x.at, 0, 1e5, 0) }));
  const chunks: { ws: typeof list; start: number; hold: number }[] = [];
  for (let i = 0; i < list.length; i += per) {
    const ws = list.slice(i, i + per);
    chunks.push({ ws, start: ws[0]!.at, hold: 0 });
  }
  const shown = chunks.map((c, i) => ({ ...c, hold: i + 1 < chunks.length ? Math.min(chunks[i + 1]!.start, c.ws[c.ws.length - 1]!.at + 20) : c.ws[c.ws.length - 1]!.at + 24 }));
  const active = shown.find((c) => f >= c.start && f < c.hold);
  if (!active) return null;
  const enter = EASE_OUT(prog(f, active.start, active.start + 4));
  const ac = safeColor(accent);
  return (
    <div style={{ position: "absolute", left: 40, right: 40, top: num(y, 1000, 1800, 1560), transform: `translateY(${(1 - enter) * 14 - 50}%)`, opacity: 0.25 + 0.75 * enter, display: "flex", justifyContent: "center" }}>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", alignItems: "center", columnGap: sz * 0.28, rowGap: sz * 0.14, maxWidth: "100%" }}>
        {active.ws.map((x, i) => {
          const started = prog(f, x.at, x.at + 4);
          const next = active.ws[i + 1];
          const on = f >= x.at && (next ? f < next.at : f < x.at + 20);
          return (
            <span key={i} style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: sz, lineHeight: 1.15, textTransform: "uppercase", letterSpacing: 0.5, color: on ? ac : "#ffffff", opacity: 0.3 + 0.7 * started, transform: `scale(${0.92 + 0.08 * EASE_OUT(started) + (on ? 0.05 : 0)})`, textShadow: "0 3px 26px rgba(0,0,0,0.65), 0 1px 4px rgba(0,0,0,0.5)" }}>
              {x.w}
            </span>
          );
        })}
      </div>
    </div>
  );
};

/** Outlined word pill centred on (x, y); pops in at frame `at`, optionally fades out ending at `until`. */
export const Chip: React.FC<{ text: string; x: number; y: number; color?: string; size?: number; at?: number; until?: number }> = ({ text, x, y, color = "yellow", size = 44, at = 0, until }) => {
  const f = useCurrentFrame();
  const p = appear(f, at, until);
  const c = safeColor(color);
  if (p <= 0.01) return null;
  return (
    <div style={{ position: "absolute", left: num(x, 0, W, 540), top: num(y, 0, H, 300), transform: `translate(-50%, -50%) translateY(${(1 - p) * 14}px) scale(${0.94 + 0.06 * p})`, opacity: p, fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: num(size, 24, 90, 44), textTransform: "uppercase", letterSpacing: 1, whiteSpace: "nowrap", color: c, border: `3px solid ${c}`, borderRadius: 999, padding: "8px 26px", background: "rgba(8,12,28,0.72)" }}>
      {txt(text, 28)}
    </div>
  );
};

/** Card with a coloured edge: a small label over a value (a stat or a one-line note). Top-left corner at (x, y). */
export const Callout: React.FC<{ label?: string; text: string; x: number; y: number; w?: number; color?: string; at?: number; until?: number }> = ({ label, text, x, y, w = 600, color = "yellow", at = 0, until }) => {
  const f = useCurrentFrame();
  const p = appear(f, at, until);
  const c = safeColor(color);
  if (p <= 0.01) return null;
  return (
    <div style={{ position: "absolute", left: num(x, 0, W, 60), top: num(y, 0, H, 300), width: num(w, 200, 1000, 600), opacity: p, transform: `translateY(${(1 - p) * 18}px)`, background: "rgba(12,14,20,0.9)", border: `2px solid ${faint(c, "66")}`, borderLeft: `10px solid ${c}`, borderRadius: 18, padding: "20px 26px", boxShadow: "0 12px 40px rgba(0,0,0,0.35)" }}>
      {label ? <div style={{ fontFamily: FONT_BODY, fontWeight: 600, fontSize: 27, letterSpacing: 3, color: c, textTransform: "uppercase" }}>{txt(label, 40)}</div> : null}
      <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 38, color: PALETTE.white, marginTop: label ? 8 : 0, lineHeight: 1.25 }}>{txt(text, 90)}</div>
    </div>
  );
};

/** A big number centred on (x, y) that counts from `from` to `to` between frames `start` and `end` (whole numbers, with commas). */
export const Counter: React.FC<{ from: number; to: number; start: number; end: number; x: number; y: number; size?: number; color?: string; prefix?: string; suffix?: string; mono?: boolean }> = ({ from, to, start, end, x, y, size = 120, color = "white", prefix = "", suffix = "", mono = false }) => {
  const f = useCurrentFrame();
  const a = num(from, -1e12, 1e12, 0);
  const b = num(to, -1e12, 1e12, 0);
  const p = EASE_OUT(prog(f, num(start, 0, 1e5, 0), num(end, 0, 1e5, 30)));
  return (
    <div style={{ position: "absolute", left: num(x, 0, W, 540), top: num(y, 0, H, 900), transform: "translate(-50%, -50%)", whiteSpace: "nowrap", fontFamily: mono ? FONT_MONO : FONT_DISPLAY, fontWeight: 700, fontSize: num(size, 30, 300, 120), color: safeColor(color, "#ffffff"), textShadow: "0 4px 30px rgba(0,0,0,0.6)" }}>
      {txt(prefix, 8)}
      {fmt(a + (b - a) * p)}
      {txt(suffix, 8)}
    </div>
  );
};
