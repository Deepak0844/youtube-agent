// yt-kit generic building blocks, drawn as <g> inside <Canvas>: Gear, Battery, Wire, Magnet, Arrow.
// Every angle, phase and fraction comes from the caller (derived from useCurrentFrame()); nothing here reads time.
//
// Wire is adapted from lib/electric.tsx (Cable) of the claude-faceless-shorts-creator kit.
// MIT License, Copyright (c) 2026 Hasan Aboul Hasan. The full notice is in THIRD_PARTY_NOTICES.md.
import React from "react";
import { FONT_DISPLAY, H, num, polyAt, polyD, prog, safeColor, W, type Pt } from "./util";

/** Toothed wheel centred on (x, y), radius r; turn it with rot (degrees). It looks the same after a turn of 360 / teeth. */
export const Gear: React.FC<{ x: number; y: number; r?: number; teeth?: number; rot?: number; color?: string; opacity?: number }> = ({ x, y, r = 120, teeth = 10, rot = 0, color = "indigo", opacity = 1 }) => {
  const n = Math.round(num(teeth, 5, 24, 10));
  const R = num(r, 10, 600, 120);
  const pts: string[] = [];
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * 2 * Math.PI;
    const step = (2 * Math.PI) / n;
    for (const [k, rr] of [[0.0, 0.82], [0.2, 1], [0.5, 1], [0.7, 0.82]] as const) {
      const a = a0 + k * step;
      pts.push(`${Math.cos(a) * R * rr},${Math.sin(a) * R * rr}`);
    }
  }
  const c = safeColor(color, "#6366F1");
  return (
    <g transform={`translate(${num(x, -2000, 3000, 0)} ${num(y, -2000, 4000, 0)}) rotate(${num(rot, -1e6, 1e6, 0)})`} opacity={num(opacity, 0, 1, 1)}>
      <polygon points={pts.join(" ")} fill={c} stroke="#1a1a2e" strokeWidth={R * 0.04} strokeLinejoin="round" />
      <circle r={R * 0.55} fill="rgba(0,0,0,0.18)" />
      <circle r={R * 0.22} fill="#1a1a2e" />
    </g>
  );
};

/** Battery centred on (x, y), w wide; `level` 0..1 is the charge shown. */
export const Battery: React.FC<{ x: number; y: number; w?: number; level?: number; color?: string; opacity?: number }> = ({ x, y, w = 300, level = 1, color = "teal", opacity = 1 }) => {
  const bw = num(w, 40, 1000, 300);
  const bh = bw * 0.5;
  const L = num(level, 0, 1, 1);
  const c = safeColor(color, "#4db8a8");
  return (
    <g transform={`translate(${num(x, -2000, 3000, 540)} ${num(y, -2000, 4000, 900)})`} opacity={num(opacity, 0, 1, 1)} filter="url(#yk-shadow)">
      <rect x={-bw / 2} y={-bh / 2} width={bw} height={bh} rx={bh * 0.16} fill="#1a1a2e" stroke="#cdd6e2" strokeWidth={bh * 0.06} />
      <rect x={bw / 2} y={-bh * 0.18} width={bw * 0.06} height={bh * 0.36} rx={bh * 0.06} fill="#cdd6e2" />
      <rect x={-bw / 2 + bh * 0.1} y={-bh / 2 + bh * 0.1} width={Math.max(0, (bw - bh * 0.2) * L)} height={bh * 0.8} rx={bh * 0.08} fill={c} />
    </g>
  );
};

/** A cable or pipe along `pts` with n glowing dots moving along it; advance `phase` by a little every frame (for example frame * 0.012). */
export const Wire: React.FC<{ pts: readonly Pt[]; phase: number; color?: string; width?: number; n?: number; opacity?: number; dot?: number }> = ({ pts, phase, color = "yellow", width = 10, n = 5, opacity = 1, dot = 9 }) => {
  const list = pts.slice(0, 24).map((p): Pt => [num(p[0], -2000, 3000, 0), num(p[1], -2000, 4000, 0)]);
  const d = polyD(list);
  const w = num(width, 2, 60, 10);
  const c = safeColor(color);
  const count = Math.round(num(n, 0, 16, 5));
  const r = num(dot, 2, 40, 9);
  const ph = num(phase, -1e6, 1e6, 0);
  return (
    <g opacity={num(opacity, 0, 1, 1)}>
      <path d={d} stroke="#1c2438" strokeWidth={w + 8} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <path d={d} stroke="#46506a" strokeWidth={w} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      {Array.from({ length: count }).map((_, i) => {
        const [px, py] = polyAt(list, ph + i / Math.max(1, count));
        return (
          <g key={i}>
            <circle cx={px} cy={py} r={r * 2.2} fill={c} opacity={0.22} />
            <circle cx={px} cy={py} r={r} fill={c} />
          </g>
        );
      })}
    </g>
  );
};

/** Bar magnet centred on (x, y), w wide: red N half, blue S half. rot in degrees. */
export const Magnet: React.FC<{ x: number; y: number; w?: number; rot?: number; opacity?: number }> = ({ x, y, w = 420, rot = 0, opacity = 1 }) => {
  const mw = num(w, 60, 1000, 420);
  const mh = mw * 0.42;
  return (
    <g transform={`translate(${num(x, -2000, 3000, 540)} ${num(y, -2000, 4000, 900)}) rotate(${num(rot, -1e6, 1e6, 0)})`} opacity={num(opacity, 0, 1, 1)} filter="url(#yk-shadow)">
      <rect x={-mw / 2} y={-mh / 2} width={mw / 2} height={mh} rx={mh * 0.1} fill="url(#yk-redmag)" stroke="#7d1f34" strokeWidth={mh * 0.03} />
      <rect x={0} y={-mh / 2} width={mw / 2} height={mh} rx={mh * 0.1} fill="url(#yk-bluemag)" stroke="#1d3688" strokeWidth={mh * 0.03} />
      <text x={-mw / 4} y={mh * 0.28} fontSize={mh * 0.8} fontWeight={700} fill="#fff" textAnchor="middle" fontFamily={FONT_DISPLAY}>N</text>
      <text x={mw / 4} y={mh * 0.28} fontSize={mh * 0.8} fontWeight={700} fill="#fff" textAnchor="middle" fontFamily={FONT_DISPLAY}>S</text>
    </g>
  );
};

/** Arrow from (x1, y1) to (x2, y2); `grow` 0..1 draws it from the tail to the head. */
export const Arrow: React.FC<{ x1: number; y1: number; x2: number; y2: number; color?: string; width?: number; grow?: number; opacity?: number }> = ({ x1, y1, x2, y2, color = "white", width = 12, grow = 1, opacity = 1 }) => {
  const ax = num(x1, -W, 2 * W, 0);
  const ay = num(y1, -H, 2 * H, 0);
  const g = prog(num(grow, 0, 1, 1), 0, 1);
  const bx = ax + (num(x2, -W, 2 * W, 0) - ax) * g;
  const by = ay + (num(y2, -H, 2 * H, 0) - ay) * g;
  const w = num(width, 2, 60, 12);
  const ang = Math.atan2(by - ay, bx - ax);
  const head = w * 2.6;
  const c = safeColor(color, "#ffffff");
  if (g <= 0.01) return null;
  return (
    <g opacity={num(opacity, 0, 1, 1)}>
      <line x1={ax} y1={ay} x2={bx - Math.cos(ang) * head * 0.6} y2={by - Math.sin(ang) * head * 0.6} stroke={c} strokeWidth={w} strokeLinecap="round" />
      <polygon points={`${bx},${by} ${bx - Math.cos(ang - 0.45) * head},${by - Math.sin(ang - 0.45) * head} ${bx - Math.cos(ang + 0.45) * head},${by - Math.sin(ang + 0.45) * head}`} fill={c} />
    </g>
  );
};
