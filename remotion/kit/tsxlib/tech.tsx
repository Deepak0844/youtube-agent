// yt-kit tech props, drawn as <g> inside <Canvas>: Laptop, ServerRack, Container, CargoShip, Cloud, StatusBadge, LayerStack.
// Each is placed by its centre (x, y) and its width w; the height follows the drawing's shape.
//
// Adapted from lib/techprops.tsx of the claude-faceless-shorts-creator kit (restyled for the dark brand stage: ink outlines,
// soft shadow instead of the paper-cut sticker edge).
// MIT License, Copyright (c) 2026 Hasan Aboul Hasan. The full notice is in THIRD_PARTY_NOTICES.md.
import React from "react";
import { useCurrentFrame } from "remotion";
import { EASE_OUT, FONT_BODY, FONT_DISPLAY, num, prog, safeColor, txt } from "./util";

const INK = "#1a1a2e";
const SW = 6;

const Prop: React.FC<{ x: number; y: number; w: number; vw: number; vh: number; opacity?: number; children: React.ReactNode }> = ({ x, y, w, vw, vh, opacity = 1, children }) => {
  const ww = num(w, 20, 2000, 400);
  const k = ww / vw;
  return (
    <g transform={`translate(${num(x, -2000, 3000, 540) - ww / 2} ${num(y, -2000, 4000, 900) - (vh * k) / 2}) scale(${k})`} opacity={num(opacity, 0, 1, 1)} filter="url(#yk-shadow)">
      {children}
    </g>
  );
};
type Base = { x: number; y: number; w?: number; opacity?: number };

/** Laptop whose screen shows code lines; state "ok" tints them green, "err" red. */
export const Laptop: React.FC<Base & { state?: "code" | "ok" | "err" }> = ({ x, y, w = 560, opacity, state = "code" }) => {
  const tint = state === "ok" ? "#6fd08c" : state === "err" ? "#ff7a66" : "#8fb7c9";
  const lines = [[0, 90, tint], [18, 140, "#d9c27a"], [18, 110, tint], [36, 160, "#c9a0dc"], [18, 70, tint], [0, 120, "#d9c27a"], [0, 60, tint]] as const;
  return (
    <Prop x={x} y={y} w={w} vw={400} vh={256} opacity={opacity}>
      <rect x="44" y="4" width="312" height="204" rx="16" fill="#463e33" stroke={INK} strokeWidth={SW} />
      <rect x="60" y="20" width="280" height="172" rx="6" fill="#1d2b2c" />
      {lines.map(([ind, len, c], i) => <rect key={i} x={76 + ind} y={36 + i * 21} width={len} height="9" rx="4.5" fill={c} opacity={0.92} />)}
      <path d="M 6 210 L 394 210 L 380 238 Q 378 244 370 244 L 30 244 Q 22 244 20 238 Z" fill="#d6cab3" stroke={INK} strokeWidth={SW} strokeLinejoin="round" />
      <rect x="160" y="210" width="80" height="12" rx="6" fill="#b9ab90" />
    </Prop>
  );
};

/** Five-unit server rack with blinking lights (they follow the frame); err turns them red and faster. */
export const ServerRack: React.FC<Base & { err?: boolean }> = ({ x, y, w = 300, opacity, err = false }) => {
  const frame = useCurrentFrame();
  return (
    <Prop x={x} y={y} w={w} vw={240} vh={420} opacity={opacity}>
      <rect x="6" y="6" width="228" height="408" rx="14" fill="#33343a" stroke={INK} strokeWidth={SW} />
      {[0, 1, 2, 3, 4].map((u) => {
        const yy = 22 + u * 78;
        return (
          <g key={u}>
            <rect x="22" y={yy} width="196" height="64" rx="8" fill="#4b4d56" stroke={INK} strokeWidth={4} />
            {[0, 1, 2, 3, 4, 5].map((s) => <rect key={s} x={36 + s * 16} y={yy + 14} width="9" height="22" rx="3" fill="#2a2b30" />)}
            {[0, 1, 2].map((l) => {
              const on = (frame + u * 7 + l * 11) % (err ? 18 : 30) < (err ? 11 : 20);
              return <circle key={l} cx={182 + l * 12} cy={yy + 32} r="4.6" fill={err ? "#ff5a45" : "#58e08a"} opacity={on ? 1 : 0.28} />;
            })}
            <rect x="36" y={yy + 46} width="70" height="5" rx="2.5" fill="#6a6d78" />
          </g>
        );
      })}
    </Prop>
  );
};

/** Shipping container in any colour, with an optional label (and a smaller second line). */
export const Container: React.FC<Base & { color?: string; label?: string; sub?: string }> = ({ x, y, w = 420, opacity, color = "blue", label, sub }) => (
  <Prop x={x} y={y} w={w} vw={400} vh={200} opacity={opacity}>
    <rect x="8" y="8" width="384" height="184" rx="8" fill={safeColor(color, "#2b7fc4")} stroke={INK} strokeWidth={SW} />
    {Array.from({ length: 17 }).map((_, i) => <line key={i} x1={36 + i * 21.6} y1="16" x2={36 + i * 21.6} y2="184" stroke="rgba(0,0,0,0.2)" strokeWidth="5" />)}
    <rect x="8" y="8" width="26" height="184" fill="rgba(0,0,0,0.18)" />
    <rect x="366" y="8" width="26" height="184" fill="rgba(0,0,0,0.18)" />
    {label ? (
      <g>
        <rect x="70" y={sub ? 60 : 72} width="260" height={sub ? 82 : 58} rx="6" fill="#f2efe6" stroke={INK} strokeWidth={4} />
        <text x="200" y={sub ? 96 : 111} textAnchor="middle" fontFamily={FONT_DISPLAY} fontWeight={700} fontSize="34" fill={INK}>{txt(label, 14)}</text>
        {sub ? <text x="200" y="127" textAnchor="middle" fontFamily={FONT_BODY} fontWeight={600} fontSize="20" fill="#4a4a5e">{txt(sub, 22)}</text> : null}
      </g>
    ) : null}
  </Prop>
);

/** Cargo ship loaded with three rows of mixed containers. */
export const CargoShip: React.FC<Base> = ({ x, y, w = 800, opacity }) => {
  const palette = ["#c0492b", "#2b7fc4", "#f5d76e", "#4db8a8", "#7c8590"];
  return (
    <Prop x={x} y={y} w={w} vw={600} vh={270} opacity={opacity}>
      {[0, 1, 2].map((r) => Array.from({ length: 6 }).map((_, c) => (
        <rect key={`${r}-${c}`} x={50 + c * 66} y={72 + r * 38} width="62" height="34" rx="3" fill={palette[(r * 3 + c * 2 + (r % 2)) % palette.length]} stroke={INK} strokeWidth={3.5} />
      )))}
      <rect x="456" y="30" width="86" height="80" rx="4" fill="#f2efe6" stroke={INK} strokeWidth={SW} />
      <rect x="470" y="46" width="58" height="20" rx="2" fill="#7fa6b8" stroke={INK} strokeWidth={3} />
      <rect x="494" y="8" width="14" height="24" fill={INK} />
      <path d="M 14 172 L 586 172 L 540 244 Q 534 252 524 252 L 76 252 Q 66 252 60 244 Z" fill="#35465a" stroke={INK} strokeWidth={SW} strokeLinejoin="round" />
      <rect x="24" y="168" width="552" height="10" fill="#e8586f" />
      <path d="M 0 260 Q 50 244 100 260 T 200 260 T 300 260 T 400 260 T 500 260 T 600 260" fill="none" stroke="#6fa0b8" strokeWidth="7" strokeLinecap="round" />
    </Prop>
  );
};

/** Flat cloud. */
export const Cloud: React.FC<Base> = ({ x, y, w = 420, opacity }) => (
  <Prop x={x} y={y} w={w} vw={300} vh={200} opacity={opacity}>
    <path d="M 70 170 Q 18 168 20 124 Q 22 88 64 86 Q 70 40 124 38 Q 168 34 188 70 Q 236 62 252 104 Q 284 112 278 144 Q 272 172 236 170 Z" fill="#e8f1f5" stroke={INK} strokeWidth={SW} strokeLinejoin="round" />
    <path d="M 70 128 Q 100 112 130 128 M 150 112 Q 178 98 206 114" fill="none" stroke="#b8cdd6" strokeWidth="6" strokeLinecap="round" />
  </Prop>
);

/** Round check ("ok") or cross ("err") badge centred on (x, y) that draws its glyph between frames `at` and `at + 16`. */
export const StatusBadge: React.FC<{ kind: "ok" | "err"; x: number; y: number; r?: number; at?: number; opacity?: number }> = ({ kind, x, y, r = 70, at = 0, opacity }) => {
  const f = useCurrentFrame();
  const a = num(at, 0, 1e5, 0);
  const p = EASE_OUT(prog(f, a + 4, a + 16));
  const col = kind === "ok" ? "#2f9e5c" : "#e8586f";
  const len = kind === "ok" ? 90 : 100;
  return (
    <Prop x={x} y={y} w={num(r, 10, 400, 70) * 2} vw={100} vh={100} opacity={opacity === undefined ? EASE_OUT(prog(f, a, a + 8)) : opacity}>
      <circle cx="50" cy="50" r="46" fill="#f2efe6" stroke={col} strokeWidth="8" />
      <path d={kind === "ok" ? "M 26 52 L 43 68 L 74 34" : "M 32 32 L 68 68 M 68 32 L 32 68"} fill="none" stroke={col} strokeWidth="11" strokeLinecap="round" strokeLinejoin="round" strokeDasharray={len} strokeDashoffset={len * (1 - p)} />
    </Prop>
  );
};

export type StackBlock = { label: string; color: string; h?: number };

/** Labelled blocks (listed bottom to top) that rise one after another from frame `at`; (x, y) is the centre of the bottom edge. */
export const LayerStack: React.FC<{ blocks: readonly StackBlock[]; x: number; y: number; w?: number; at?: number; stagger?: number; opacity?: number }> = ({ blocks, x, y, w = 760, at = 0, stagger = 6, opacity = 1 }) => {
  const f = useCurrentFrame();
  const ww = num(w, 100, 1040, 760);
  let acc = 0;
  return (
    <g opacity={num(opacity, 0, 1, 1)}>
      {blocks.slice(0, 8).map((b, i) => {
        const h = num(b.h, 40, 300, 100);
        const bottom = acc;
        acc += h;
        const p = EASE_OUT(prog(f, num(at, 0, 1e5, 0) + i * num(stagger, 0, 60, 6), num(at, 0, 1e5, 0) + i * num(stagger, 0, 60, 6) + 10));
        return (
          <g key={i} opacity={p} transform={`translate(0 ${(1 - p) * 40})`} filter="url(#yk-shadow)">
            <rect x={num(x, -2000, 3000, 540) - ww / 2} y={num(y, -2000, 4000, 1000) - bottom - h + 4} width={ww} height={h - 8} rx={10} fill={safeColor(b.color, "#6366F1")} stroke={INK} strokeWidth={4} />
            <text x={num(x, -2000, 3000, 540)} y={num(y, -2000, 4000, 1000) - bottom - h / 2 + 12} textAnchor="middle" fontFamily={FONT_BODY} fontWeight={600} fontSize={38} fill={INK}>{txt(b.label, 24)}</text>
          </g>
        );
      })}
    </g>
  );
};
