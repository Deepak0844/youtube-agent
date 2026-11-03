// yt-kit electricity props, drawn as <g> inside <Canvas> (it provides the gradients): Bulb, Generator, MagnetCoil, Boiler,
// WindTurbine, Dam, SolarPanel, Pylon, Donut. Pure functions of their props: the caller drives every angle and phase
// from useCurrentFrame() (use rotorAngle() for rotors so the last frame matches frame 0).
//
// Adapted from lib/electric.tsx of the claude-faceless-shorts-creator kit (Turbine renamed Generator).
// MIT License, Copyright (c) 2026 Hasan Aboul Hasan. The full notice is in THIRD_PARTY_NOTICES.md.
import React from "react";
import { FONT_DISPLAY, polyAt, polyD, saneNumbers, txt } from "./util";

const GOLD = "#f5d76e";
const CYAN = "#4ecdc4";
const BLUE = "#5b8def";
const RED = "#e8586f";
const RAD = Math.PI / 180;

// -----------------------------------------------------------------------------
// Bulb — glass, filament, screw base, halo + rays. glow 0..1. Height ~ 330*s.
// -----------------------------------------------------------------------------
const BulbRaw: React.FC<{ cx: number; cy: number; s?: number; glow?: number }> = ({ cx, cy, s = 1, glow = 1 }) => (
  <g transform={`translate(${cx} ${cy}) scale(${s})`}>
    <circle cx={0} cy={-30} r={340} fill="url(#yk-halo)" opacity={glow} />
    {Array.from({ length: 14 }).map((_, i) => {
      const a = (i / 14) * 360 * RAD;
      const r1 = 150;
      const r2 = 215 + (i % 2) * 45;
      return (
        <line key={i} x1={Math.cos(a) * r1} y1={-30 + Math.sin(a) * r1} x2={Math.cos(a) * r2} y2={-30 + Math.sin(a) * r2} stroke={GOLD} strokeWidth={9} strokeLinecap="round" opacity={0.85 * glow} />
      );
    })}
    <path d="M -46 78 C -46 44 -108 24 -108 -48 A 108 108 0 1 1 108 -48 C 108 24 46 44 46 78 Z" fill="url(#yk-glass)" opacity={0.25 + 0.75 * glow} stroke="#fff6cf" strokeWidth={5} />
    <path d="M -22 78 L -22 6 M 22 78 L 22 6 M -22 6 L -12 -44 L -4 -8 L 4 -44 L 12 -8 L 22 6" stroke="#e8861b" strokeWidth={6} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    <rect x={-52} y={74} width={104} height={20} rx={6} fill="url(#yk-steel)" />
    <rect x={-52} y={98} width={104} height={20} rx={6} fill="url(#yk-steel)" />
    <rect x={-52} y={122} width={104} height={20} rx={6} fill="url(#yk-steel)" />
    <path d="M -30 146 L 30 146 L 20 166 L -20 166 Z" fill="#3b4558" />
  </g>
);

// -----------------------------------------------------------------------------
// Turbine — front view of a generator: steel housing, copper coil ring, spinning blades.
// -----------------------------------------------------------------------------
const GeneratorRaw: React.FC<{ cx: number; cy: number; r: number; rot: number; glow?: number; blur?: number }> = ({ cx, cy, r, rot, glow = 0.5, blur = 0 }) => {
  const blade = `M 0 0 C ${r * 0.1} ${-r * 0.22} ${r * 0.42} ${-r * 0.34} ${r * 0.7} ${-r * 0.2} L ${r * 0.72} ${r * 0.04} C ${r * 0.45} ${-r * 0.02} ${r * 0.2} ${r * 0.08} 0 ${r * 0.1} Z`;
  return (
    <g transform={`translate(${cx} ${cy})`}>
      <ellipse cx={0} cy={r * 1.12} rx={r * 1.25} ry={r * 0.12} fill="#000" opacity={0.35} />
      <path d={`M ${-r * 0.8} ${r * 0.8} L ${-r * 1.05} ${r * 1.1} L ${r * 1.05} ${r * 1.1} L ${r * 0.8} ${r * 0.8} Z`} fill="#3b4558" />
      <rect x={-r * 1.18} y={r * 1.06} width={r * 2.36} height={r * 0.1} rx={r * 0.03} fill="#2a3246" />
      <circle r={r} fill="url(#yk-steel)" stroke="#2a3246" strokeWidth={r * 0.03} />
      {Array.from({ length: 24 }).map((_, i) => {
        const lit = 0.5 + 0.5 * Math.sin(i * 0.9 - rot * 0.12);
        return (
          <g key={i} transform={`rotate(${(i / 24) * 360})`}>
            <rect x={-r * 0.055} y={-r * 0.93} width={r * 0.11} height={r * 0.17} rx={r * 0.02} fill="url(#yk-copper)" />
            <rect x={-r * 0.055} y={-r * 0.93} width={r * 0.11} height={r * 0.17} rx={r * 0.02} fill={GOLD} opacity={glow * lit * 0.8} />
          </g>
        );
      })}
      <circle r={r * 0.72} fill="#0f1526" stroke="#2a3246" strokeWidth={r * 0.025} />
      <g transform={`rotate(${rot})`}>
        {Array.from({ length: 8 }).map((_, i) => (
          <path key={i} d={blade} transform={`rotate(${i * 45})`} fill="url(#yk-steel)" stroke="#2a3246" strokeWidth={r * 0.012} opacity={1 - 0.55 * blur} />
        ))}
      </g>
      {blur > 0 ? <circle r={r * 0.7} fill="#9fb3d6" opacity={0.28 * blur} /> : null}
      <circle r={r * 0.15} fill={GOLD} stroke="#a9852a" strokeWidth={r * 0.02} />
      <circle r={r * 0.06} fill="#fff6c2" />
      <rect x={r * 0.9} y={-r * 0.12} width={r * 0.3} height={r * 0.24} rx={r * 0.04} fill="#3b4558" />
      <circle cx={r * 1.2} cy={0} r={r * 0.07} fill={GOLD} opacity={0.4 + 0.6 * glow} />
    </g>
  );
};

// -----------------------------------------------------------------------------
// MagnetCoil — N/S magnets, rotating wire loop with electrons, galvanometer. ~ 960 wide x 760 tall.
// ang = loop angle deg; flow = electron phase; flowOn 0..1 = electrons visible; needle -1..1.
// -----------------------------------------------------------------------------
const MagnetCoilRaw: React.FC<{ cx: number; cy: number; ang: number; flow: number; flowOn: number; needle: number; fieldOn: number }> = ({
  cx, cy, ang, flow, flowOn, needle, fieldOn,
}) => {
  const lw = 230 * Math.cos(ang * RAD);
  const lh = 320;
  const loop: [number, number][] = [[-lw / 2, 150], [-lw / 2, -lh / 2], [lw / 2, -lh / 2], [lw / 2, 150], [14, 150], [14, 260], [0, 300], [0, 340]];
  const na = (-70 + 140 * ((needle + 1) / 2)) * RAD;
  return (
    <g transform={`translate(${cx} ${cy})`}>
      <rect x={-480} y={-250} width={210} height={420} rx={22} fill="url(#yk-redmag)" stroke="#7d1f34" strokeWidth={6} />
      <rect x={270} y={-250} width={210} height={420} rx={22} fill="url(#yk-bluemag)" stroke="#1d3688" strokeWidth={6} />
      <text x={-375} y={-20} fontSize={150} fontWeight={700} fill="#fff" textAnchor="middle" fontFamily={FONT_DISPLAY}>N</text>
      <text x={375} y={-20} fontSize={150} fontWeight={700} fill="#fff" textAnchor="middle" fontFamily={FONT_DISPLAY}>S</text>
      {[-170, -90, -10, 70, 130].map((y, i) => (
        <path key={i} d={`M -262 ${y} C -120 ${y - 50} 120 ${y - 50} 262 ${y}`} stroke="#b7c6ff" strokeWidth={4} strokeDasharray="16 14" strokeDashoffset={-flow * 140} fill="none" opacity={0.55 * fieldOn} />
      ))}
      <line x1={0} y1={-230} x2={0} y2={170} stroke="#7b869b" strokeWidth={8} />
      <path d={polyD(loop.slice(0, 5))} stroke="#7a3f14" strokeWidth={22} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <path d={polyD(loop.slice(0, 5))} stroke="url(#yk-copper)" strokeWidth={14} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <path d={polyD(loop.slice(4))} stroke="#7a3f14" strokeWidth={14} fill="none" strokeLinecap="round" />
      <circle cx={0} cy={-240} r={22} fill={GOLD} stroke="#a9852a" strokeWidth={5} />
      <rect x={-10} y={-300} width={20} height={64} rx={8} fill="#3b4558" />
      {Array.from({ length: 9 }).map((_, i) => {
        const [x, y] = polyAt(loop, flow * 0.5 + i / 9);
        return (
          <g key={i} opacity={flowOn}>
            <circle cx={x} cy={y} r={20} fill={CYAN} opacity={0.25} />
            <circle cx={x} cy={y} r={10} fill={CYAN} />
          </g>
        );
      })}
      <g transform="translate(0 440)">
        <path d="M -170 0 A 170 170 0 0 1 170 0 Z" fill="#f4f0e2" stroke="#3b4558" strokeWidth={8} />
        {Array.from({ length: 9 }).map((_, i) => {
          const a = (-70 + i * 17.5) * RAD;
          return <line key={i} x1={Math.sin(a) * 120} y1={-Math.cos(a) * 120} x2={Math.sin(a) * 148} y2={-Math.cos(a) * 148} stroke="#3b4558" strokeWidth={5} />;
        })}
        <line x1={0} y1={0} x2={Math.sin(na) * 138} y2={-Math.cos(na) * 138} stroke={RED} strokeWidth={8} strokeLinecap="round" />
        <circle r={14} fill="#3b4558" />
        <rect x={-190} y={0} width={380} height={34} rx={10} fill="url(#yk-steel)" />
      </g>
    </g>
  );
};

// -----------------------------------------------------------------------------
// Boiler — steel tank with water gauge, firebox with animated flames, steam puffs.
// -----------------------------------------------------------------------------
const BoilerRaw: React.FC<{ cx: number; cy: number; w: number; t: number; fire?: number }> = ({ cx, cy, w, t, fire = 1 }) => {
  const h = w * 0.5;
  return (
    <g transform={`translate(${cx} ${cy})`}>
      <rect x={-w * 0.32} y={h / 2 - 4} width={w * 0.64} height={h * 0.42} rx={14} fill="#241c1a" stroke="#4a3b36" strokeWidth={6} />
      <circle cx={0} cy={h / 2 + h * 0.2} r={w * 0.3} fill="#ff7a1a" opacity={0.28 * fire} />
      {[-0.22, -0.11, 0, 0.11, 0.22].map((fx, i) => {
        const hh = (0.65 + 0.35 * Math.sin(t * 0.45 + i * 1.9)) * fire;
        const x0 = fx * w;
        const y0 = h / 2 + h * 0.4;
        const fh = 120 * hh;
        return (
          <g key={i}>
            <path d={`M ${x0 - 34} ${y0} C ${x0 - 44} ${y0 - fh * 0.5} ${x0 - 8} ${y0 - fh * 0.7} ${x0} ${y0 - fh} C ${x0 + 12} ${y0 - fh * 0.6} ${x0 + 46} ${y0 - fh * 0.4} ${x0 + 34} ${y0} Z`} fill="#ff6a1a" />
            <path d={`M ${x0 - 18} ${y0} C ${x0 - 22} ${y0 - fh * 0.35} ${x0 - 4} ${y0 - fh * 0.5} ${x0} ${y0 - fh * 0.62} C ${x0 + 6} ${y0 - fh * 0.4} ${x0 + 24} ${y0 - fh * 0.25} ${x0 + 18} ${y0} Z`} fill={GOLD} />
          </g>
        );
      })}
      <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={h * 0.32} fill="url(#yk-steel)" stroke="#2a3246" strokeWidth={7} />
      {[-0.3, 0, 0.3].map((bx, i) => (
        <g key={i}>
          <rect x={bx * w - 9} y={-h / 2 + 6} width={18} height={h - 12} fill="#46506a" opacity={0.55} />
          {[-0.28, 0.28].map((ry, j) => <circle key={j} cx={bx * w} cy={ry * h} r={7} fill="#2a3246" />)}
        </g>
      ))}
      <rect x={-w * 0.12} y={-h * 0.26} width={w * 0.24} height={h * 0.52} rx={18} fill="#0f1526" stroke="#2a3246" strokeWidth={6} />
      <path d={`M ${-w * 0.1} ${h * 0.02} q ${w * 0.025} -10 ${w * 0.05} 0 t ${w * 0.05} 0 t ${w * 0.05} 0 V ${h * 0.24} H ${-w * 0.1} Z`} fill="url(#yk-water)" transform={`translate(${Math.sin(t * 0.2) * 6} 0)`} />
      <rect x={-w * 0.04} y={-h / 2 - 34} width={w * 0.08} height={36} rx={8} fill="#46506a" />
      {[0, 1, 2, 3].map((i) => {
        const ph = (t * 0.018 + i / 4) % 1;
        return <circle key={i} cx={Math.sin(ph * 6 + i) * 22} cy={-h / 2 - 40 - ph * 150} r={26 + ph * 40} fill="#e8eef8" opacity={0.55 * (1 - ph)} />;
      })}
    </g>
  );
};

// -----------------------------------------------------------------------------
// Wind turbine — tapered tower, nacelle, 3 blades. h = tower height, blade length ~ 0.8h.
// -----------------------------------------------------------------------------
const WindTurbineRaw: React.FC<{ x: number; baseY: number; h: number; rot: number }> = ({ x, baseY, h, rot }) => {
  const L = h * 0.82;
  const hubY = baseY - h;
  return (
    <g transform={`translate(${x} 0)`}>
      <path d={`M ${-h * 0.05} ${baseY} L ${-h * 0.018} ${hubY} L ${h * 0.018} ${hubY} L ${h * 0.05} ${baseY} Z`} fill="#eef2f8" stroke="#8d99ae" strokeWidth={3} />
      <rect x={-h * 0.08} y={hubY - h * 0.04} width={h * 0.2} height={h * 0.08} rx={h * 0.03} fill="#dfe6f1" stroke="#8d99ae" strokeWidth={3} />
      <g transform={`translate(0 ${hubY}) rotate(${rot})`}>
        {[0, 120, 240].map((a) => (
          <path key={a} transform={`rotate(${a})`} d={`M ${-h * 0.025} 0 L ${-h * 0.012} ${-L} L ${h * 0.012} ${-L} L ${h * 0.035} 0 Z`} fill="#f7f9fc" stroke="#8d99ae" strokeWidth={3} />
        ))}
        <circle r={h * 0.045} fill="#cfd8e6" stroke="#8d99ae" strokeWidth={3} />
      </g>
    </g>
  );
};

// -----------------------------------------------------------------------------
// Dam — concrete wall, reservoir, waterfall spilling onto a spinning water wheel.
// (x,y) = wall base-left of the whole prop; ~340 wide, 330 tall.
// -----------------------------------------------------------------------------
const DamRaw: React.FC<{ x: number; y: number; t: number; rot: number }> = ({ x, y, t, rot }) => (
  <g transform={`translate(${x} ${y})`}>
    <rect x={90} y={-250} width={250} height={250} fill="url(#yk-water)" />
    <path d={`M 90 -250 q 20 -12 40 0 t 40 0 t 40 0 t 40 0 t 40 0 t 40 0 V -236 H 90 Z`} fill="#8fd6ff" transform={`translate(${Math.sin(t * 0.15) * 8} 0)`} />
    <path d="M 40 -300 L 100 -300 L 120 0 L 20 0 Z" fill="url(#yk-concrete)" stroke="#6b7486" strokeWidth={4} />
    {[-220, -150, -80].map((yy, i) => <line key={i} x1={44 + i * 2} y1={yy} x2={98 + i * 2} y2={yy} stroke="#7b8497" strokeWidth={3} />)}
    {[0, 1, 2, 3, 4, 5].map((i) => {
      const ph = (t * 0.05 + i / 6) % 1;
      return <ellipse key={i} cx={22 - ph * 6} cy={-90 + ph * 150} rx={9} ry={16} fill="#8fd6ff" opacity={0.9} />;
    })}
    <rect x={0} y={-100} width={30} height={160} fill="#8fd6ff" opacity={0.55} transform="translate(-6 0)" />
    <rect x={-140} y={40} width={260} height={46} rx={10} fill="url(#yk-water)" />
    <g transform={`translate(-40 20) rotate(${rot})`}>
      <circle r={70} fill="#4a3b36" stroke="#2a3246" strokeWidth={5} />
      {Array.from({ length: 8 }).map((_, i) => (
        <rect key={i} x={-9} y={-96} width={18} height={44} rx={4} fill="#c98b4a" transform={`rotate(${i * 45})`} />
      ))}
      <circle r={16} fill={GOLD} />
    </g>
  </g>
);

// -----------------------------------------------------------------------------
// SolarPanel — tilted cell grid (bilinear), sun with rays, light beams, electrons. ~ w wide.
// lit 0..1 sweeps cells on; beams 0..1; flow = electron phase.
// -----------------------------------------------------------------------------
const SolarPanelRaw: React.FC<{ cx: number; cy: number; w: number; lit: number; beams: number; flow: number; t: number }> = ({ cx, cy, w, lit, beams, flow, t }) => {
  const topHalf = w * 0.34;
  const botHalf = w * 0.5;
  const ht = w * 0.27;
  const hb = w * 0.27;
  const cols = 6;
  const rows = 4;
  const P = (u: number, v: number): [number, number] => {
    const half = topHalf + (botHalf - topHalf) * v;
    return [(u - 0.5) * 2 * half, -ht + (ht + hb) * v];
  };
  const sun: [number, number] = [w * 0.44, -w * 0.48];
  return (
    <g transform={`translate(${cx} ${cy})`}>
      <circle cx={sun[0]} cy={sun[1]} r={w * 0.36} fill="url(#yk-sun)" opacity={0.75} />
      {Array.from({ length: 12 }).map((_, i) => {
        const a = (i / 12) * 360 * RAD + t * 0.01;
        return <line key={i} x1={sun[0] + Math.cos(a) * w * 0.15} y1={sun[1] + Math.sin(a) * w * 0.15} x2={sun[0] + Math.cos(a) * w * 0.24} y2={sun[1] + Math.sin(a) * w * 0.24} stroke={GOLD} strokeWidth={8} strokeLinecap="round" />;
      })}
      <circle cx={sun[0]} cy={sun[1]} r={w * 0.12} fill="#fff1a0" />
      {[0.15, 0.4, 0.65, 0.88].map((u, i) => {
        const [px, py] = P(u, 0.1);
        return <polygon key={i} points={`${sun[0] - 22},${sun[1] + 40} ${sun[0] + 22},${sun[1] + 30} ${px + 40},${py} ${px - 40},${py + 10}`} fill={GOLD} opacity={0.2 * beams} />;
      })}
      <path d={`M ${-w * 0.12} ${hb} L ${-w * 0.2} ${hb + w * 0.18} M ${w * 0.12} ${hb} L ${w * 0.2} ${hb + w * 0.18}`} stroke="#6b7486" strokeWidth={14} strokeLinecap="round" />
      <polygon points={[P(0, 0), P(1, 0), P(1, 1), P(0, 1)].map((p) => `${p[0]},${p[1]}`).join(" ")} fill="#cdd6e2" stroke="#8d99ae" strokeWidth={6} />
      {Array.from({ length: rows }).map((_, r) =>
        Array.from({ length: cols }).map((__, c) => {
          const g = 0.04;
          const [a, b, c2, d] = [P((c + g) / cols, (r + g) / rows), P((c + 1 - g) / cols, (r + g) / rows), P((c + 1 - g) / cols, (r + 1 - g) / rows), P((c + g) / cols, (r + 1 - g) / rows)];
          const idx = (r * cols + c) / (rows * cols);
          const on = Math.max(0, Math.min(1, (lit - idx * 0.8) / 0.2));
          const pts = [a, b, c2, d].map((p) => `${p[0]},${p[1]}`).join(" ");
          return (
            <g key={`${r}-${c}`}>
              <polygon points={pts} fill="url(#yk-cell)" />
              <polygon points={pts} fill={CYAN} opacity={0.5 * on} />
            </g>
          );
        }),
      )}
      {Array.from({ length: 7 }).map((_, i) => {
        const e: [number, number][] = [P(0.15 + i * 0.11, 0.1), P(0.15 + i * 0.11, 0.97), [0, hb + 40], [0, hb + 160]];
        const [x, y] = polyAt(e, flow * 0.6 + i / 7);
        return <circle key={i} cx={x} cy={y} r={9} fill="#fff" opacity={lit > 0.6 ? 0.95 : 0} />;
      })}
    </g>
  );
};

// -----------------------------------------------------------------------------
// Pylon — lattice transmission tower.
// -----------------------------------------------------------------------------
const PylonRaw: React.FC<{ x: number; baseY: number; h: number }> = ({ x, baseY, h }) => {
  const w = h * 0.34;
  const top = baseY - h;
  const arm = (yy: number, half: number) => <line x1={x - half} y1={yy} x2={x + half} y2={yy} stroke="#9aa7ba" strokeWidth={6} strokeLinecap="round" />;
  return (
    <g stroke="#9aa7ba" strokeWidth={5} fill="none" strokeLinejoin="round">
      <path d={`M ${x - w / 2} ${baseY} L ${x - 8} ${top} L ${x + 8} ${top} L ${x + w / 2} ${baseY}`} />
      <path d={`M ${x - w * 0.5} ${baseY} L ${x + w * 0.27} ${top + h * 0.4} M ${x + w * 0.5} ${baseY} L ${x - w * 0.27} ${top + h * 0.4} M ${x - w * 0.27} ${top + h * 0.4} L ${x + 4} ${top + h * 0.1} M ${x + w * 0.27} ${top + h * 0.4} L ${x - 4} ${top + h * 0.1}`} opacity={0.7} />
      {arm(top + h * 0.12, w * 0.62)}
      {arm(top + h * 0.34, w * 0.5)}
    </g>
  );
};

// -----------------------------------------------------------------------------
// Donut — percentage ring with big centre number.
// -----------------------------------------------------------------------------
const DonutRaw: React.FC<{ cx: number; cy: number; r: number; pct: number; label: string }> = ({ cx, cy, r, pct, label }) => {
  const C = 2 * Math.PI * r;
  return (
    <g transform={`translate(${cx} ${cy})`}>
      <circle r={r + 54} fill="#0e1630" opacity={0.7} />
      <circle r={r} fill="none" stroke="#2a3552" strokeWidth={70} />
      <circle r={r} fill="none" stroke={CYAN} strokeWidth={70} strokeLinecap="butt" strokeDasharray={`${C * pct} ${C}`} transform="rotate(-90)" />
      <text y={36} textAnchor="middle" fontFamily={FONT_DISPLAY} fontWeight={700} fontSize={r * 0.62} fill="#fff">{txt(label, 8)}</text>
    </g>
  );
};

// Public components: every number prop is clamped to a finite range before drawing (see saneNumbers).
export const Bulb = saneNumbers(BulbRaw);
export const Generator = saneNumbers(GeneratorRaw);
export const MagnetCoil = saneNumbers(MagnetCoilRaw);
export const Boiler = saneNumbers(BoilerRaw);
export const WindTurbine = saneNumbers(WindTurbineRaw);
export const Dam = saneNumbers(DamRaw);
export const SolarPanel = saneNumbers(SolarPanelRaw);
export const Pylon = saneNumbers(PylonRaw);
export const Donut = saneNumbers(DonutRaw);
