import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import { FONT_BODY, FONT_EDITORIAL } from './fonts';
import { EASE_OUT, Layer, VOX } from './collage';
import type { Enter } from './collage';

// =============================================================================
// techprops — flat paper-cut SVG objects (laptop, server rack, shipping container,
// cargo ship, cloud, status badges, OS stacks) for the vox collage engine. Same
// physical treatment as Cutout (cream sticker edge + soft shadow), no image gen.
// Every prop sits in a viewBox and scales to its Layer width.
// =============================================================================

const INK = VOX.ink;
const SW = 6; // outline weight in viewBox units

export const CONTAINER_COLORS = {
  docker: '#2b7fc4',
  red: '#c0492b',
  teal: VOX.teal,
  yellow: VOX.yellow,
  steel: '#7c8590',
} as const;

// -----------------------------------------------------------------------------
// PropLayer — Layer + sticker outline + shadow, for any SVG child.
// -----------------------------------------------------------------------------
export const PropLayer: React.FC<{
  x: number;
  y: number;
  w: number;
  at?: number;
  dur?: number;
  enter?: Enter;
  rotate?: number;
  depth?: number;
  drift?: number;
  sticker?: number;
  shadow?: number;
  z?: number;
  children: React.ReactNode;
}> = ({ x, y, w, at, dur, enter, rotate, depth = 0.06, drift, sticker = 5, shadow = 2, z, children }) => {
  const s = sticker;
  const outline =
    s > 0
      ? `drop-shadow(${s}px 0 0 ${VOX.cream}) drop-shadow(-${s}px 0 0 ${VOX.cream}) drop-shadow(0 ${s}px 0 ${VOX.cream}) drop-shadow(0 -${s}px 0 ${VOX.cream}) `
      : '';
  const soft = shadow > 0 ? `drop-shadow(0 ${8 * shadow}px ${10 * shadow}px rgba(40,28,12,${0.14 + 0.07 * shadow}))` : '';
  return (
    <Layer x={x} y={y} w={w} at={at} dur={dur} enter={enter} rotate={rotate} depth={depth} drift={drift} z={z}>
      <div style={{ filter: outline + soft }}>{children}</div>
    </Layer>
  );
};

const svgBase = { width: '100%', display: 'block', overflow: 'visible' } as const;

// -----------------------------------------------------------------------------
// Laptop — screen shows tiny code lines; `state` tints them and draws a status glyph.
// -----------------------------------------------------------------------------
export const LaptopSvg: React.FC<{ state?: 'code' | 'ok' | 'err' }> = ({ state = 'code' }) => {
  const tint = state === 'ok' ? '#6fd08c' : state === 'err' ? '#ff7a66' : '#8fb7c9';
  const lines = [
    [0, 90, tint],
    [18, 140, '#d9c27a'],
    [18, 110, tint],
    [36, 160, '#c9a0dc'],
    [18, 70, tint],
    [0, 120, '#d9c27a'],
    [0, 60, tint],
  ] as const;
  return (
    <svg viewBox="0 0 400 300" style={svgBase}>
      <rect x="44" y="10" width="312" height="204" rx="16" fill="#463e33" stroke={INK} strokeWidth={SW} />
      <rect x="60" y="26" width="280" height="172" rx="6" fill="#1d2b2c" />
      {lines.map(([ind, len, c], i) => (
        <rect key={i} x={76 + ind} y={42 + i * 21} width={len} height="9" rx="4.5" fill={c} opacity={0.92} />
      ))}
      <path d="M 6 216 L 394 216 L 380 244 Q 378 250 370 250 L 30 250 Q 22 250 20 244 Z" fill="#d6cab3" stroke={INK} strokeWidth={SW} strokeLinejoin="round" />
      <rect x="160" y="216" width="80" height="12" rx="6" fill="#b9ab90" />
    </svg>
  );
};

// -----------------------------------------------------------------------------
// ServerRack — five units with blinking LEDs (frame-based). `err` turns them red.
// -----------------------------------------------------------------------------
export const ServerRackSvg: React.FC<{ err?: boolean }> = ({ err = false }) => {
  const frame = useCurrentFrame();
  const units = [0, 1, 2, 3, 4];
  return (
    <svg viewBox="0 0 240 420" style={svgBase}>
      <rect x="6" y="6" width="228" height="408" rx="14" fill="#33343a" stroke={INK} strokeWidth={SW} />
      {units.map((u) => {
        const y = 22 + u * 78;
        return (
          <g key={u}>
            <rect x="22" y={y} width="196" height="64" rx="8" fill="#4b4d56" stroke={INK} strokeWidth={4} />
            {[0, 1, 2, 3, 4, 5].map((s) => (
              <rect key={s} x={36 + s * 16} y={y + 14} width="9" height="22" rx="3" fill="#2a2b30" />
            ))}
            {[0, 1, 2].map((l) => {
              const on = ((frame + u * 7 + l * 11) % (err ? 18 : 30)) < (err ? 11 : 20);
              const col = err ? '#ff5a45' : '#58e08a';
              return <circle key={l} cx={182 + l * 12} cy={y + 32} r="4.6" fill={col} opacity={on ? 1 : 0.28} />;
            })}
            <rect x="36" y={y + 46} width="70" height="5" rx="2.5" fill="#6a6d78" />
          </g>
        );
      })}
    </svg>
  );
};

// -----------------------------------------------------------------------------
// ShippingContainer — corrugated box with corner posts + door seam; optional label.
// -----------------------------------------------------------------------------
export const ContainerSvg: React.FC<{ color?: string; label?: string; sub?: string }> = ({
  color = CONTAINER_COLORS.docker,
  label,
  sub,
}) => (
  <svg viewBox="0 0 400 200" style={svgBase}>
    <rect x="8" y="8" width="384" height="184" rx="8" fill={color} stroke={INK} strokeWidth={SW} />
    {Array.from({ length: 17 }).map((_, i) => (
      <line key={i} x1={36 + i * 21.6} y1="16" x2={36 + i * 21.6} y2="184" stroke="rgba(0,0,0,0.2)" strokeWidth="5" />
    ))}
    <rect x="8" y="8" width="26" height="184" fill="rgba(0,0,0,0.18)" />
    <rect x="366" y="8" width="26" height="184" fill="rgba(0,0,0,0.18)" />
    <line x1="34" y1="100" x2="366" y2="100" stroke="rgba(0,0,0,0.0)" />
    {label ? (
      <g>
        <rect x="70" y={sub ? 60 : 72} width="260" height={sub ? 82 : 58} rx="6" fill={VOX.cream} stroke={INK} strokeWidth={4} />
        <text x="200" y={sub ? 96 : 111} textAnchor="middle" fontFamily={FONT_EDITORIAL} fontWeight={900} fontSize="34" fill={INK}>
          {label}
        </text>
        {sub ? (
          <text x="200" y="127" textAnchor="middle" fontFamily={FONT_BODY} fontWeight={600} fontSize="20" fill={VOX.inkSoft}>
            {sub}
          </text>
        ) : null}
      </g>
    ) : null}
  </svg>
);

// -----------------------------------------------------------------------------
// CargoShip — hull + bridge + three rows of mixed containers.
// -----------------------------------------------------------------------------
export const CargoShipSvg: React.FC = () => {
  const palette = [CONTAINER_COLORS.red, CONTAINER_COLORS.docker, CONTAINER_COLORS.yellow, CONTAINER_COLORS.teal, CONTAINER_COLORS.steel];
  const cell = (r: number, c: number) => palette[(r * 3 + c * 2 + (r % 2)) % palette.length];
  return (
    <svg viewBox="0 0 600 270" style={svgBase}>
      {[0, 1, 2].map((r) =>
        Array.from({ length: 6 }).map((_, c) => (
          <rect key={`${r}-${c}`} x={50 + c * 66} y={72 + r * 38} width="62" height="34" rx="3" fill={cell(r, c)} stroke={INK} strokeWidth={3.5} />
        )),
      )}
      <rect x="456" y="30" width="86" height="80" rx="4" fill={VOX.cream} stroke={INK} strokeWidth={SW} />
      <rect x="470" y="46" width="58" height="20" rx="2" fill="#7fa6b8" stroke={INK} strokeWidth={3} />
      <rect x="494" y="8" width="14" height="24" fill={INK} />
      <path d="M 14 172 L 586 172 L 540 244 Q 534 252 524 252 L 76 252 Q 66 252 60 244 Z" fill="#35465a" stroke={INK} strokeWidth={SW} strokeLinejoin="round" />
      <rect x="24" y="168" width="552" height="10" fill={VOX.red} />
      <path d="M 0 260 Q 50 244 100 260 T 200 260 T 300 260 T 400 260 T 500 260 T 600 260" fill="none" stroke="#6fa0b8" strokeWidth="7" strokeLinecap="round" />
    </svg>
  );
};

// -----------------------------------------------------------------------------
// Cloud
// -----------------------------------------------------------------------------
export const CloudSvg: React.FC = () => (
  <svg viewBox="0 0 300 200" style={svgBase}>
    <path
      d="M 70 170 Q 18 168 20 124 Q 22 88 64 86 Q 70 40 124 38 Q 168 34 188 70 Q 236 62 252 104 Q 284 112 278 144 Q 272 172 236 170 Z"
      fill="#e8f1f5"
      stroke={INK}
      strokeWidth={SW}
      strokeLinejoin="round"
    />
    <path d="M 70 128 Q 100 112 130 128 M 150 112 Q 178 98 206 114" fill="none" stroke="#b8cdd6" strokeWidth="6" strokeLinecap="round" />
  </svg>
);

// -----------------------------------------------------------------------------
// StatusBadge — round check / cross that pops in and draws its glyph.
// -----------------------------------------------------------------------------
export const StatusBadge: React.FC<{
  kind: 'ok' | 'err';
  x: number;
  y: number;
  r?: number;
  at?: number;
  depth?: number;
  z?: number;
}> = ({ kind, x, y, r = 46, at = 0, depth = 0.1, z }) => {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [at + 4, at + 16], [0, 1], { easing: EASE_OUT, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const col = kind === 'ok' ? '#2f9e5c' : VOX.red;
  const d = kind === 'ok' ? 'M 26 52 L 43 68 L 74 34' : 'M 32 32 L 68 68 M 68 32 L 32 68';
  const len = kind === 'ok' ? 90 : 100;
  return (
    <Layer x={x} y={y} w={r * 2} at={at} dur={10} enter="pop" depth={depth} drift={0.5} z={z}>
      <svg viewBox="0 0 100 100" style={{ ...svgBase, filter: 'drop-shadow(0 6px 8px rgba(40,28,12,0.3))' }}>
        <circle cx="50" cy="50" r="46" fill={VOX.cream} stroke={col} strokeWidth="8" />
        <path d={d} fill="none" stroke={col} strokeWidth="11" strokeLinecap="round" strokeLinejoin="round" strokeDasharray={len} strokeDashoffset={len * (1 - p)} />
      </svg>
    </Layer>
  );
};

// -----------------------------------------------------------------------------
// LayerStack — labelled blocks that rise bottom-up (OS diagrams, VM vs container).
// `blocks` run bottom → top; each gets a staggered entrance.
// -----------------------------------------------------------------------------
export type StackBlock = { label: string; color: string; textColor?: string; h?: number };

export const LayerStack: React.FC<{
  blocks: StackBlock[];
  x: number;
  y: number; // BOTTOM edge of the stack
  w: number;
  at?: number;
  stagger?: number;
  depth?: number;
}> = ({ blocks, x, y, w, at = 0, stagger = 6, depth = 0.05 }) => {
  const frame = useCurrentFrame();
  const total = blocks.reduce((a, b) => a + (b.h ?? 84), 0);
  let acc = 0;
  return (
    <Layer x={x} y={y - total / 2} w={w} at={at} dur={1} enter="none" depth={depth} drift={0.5}>
      <div style={{ position: 'relative', width: w, height: total }}>
        {blocks.map((b, i) => {
          const h = b.h ?? 84;
          const bottom = acc;
          acc += h;
          const p = interpolate(frame, [at + i * stagger, at + i * stagger + 10], [0, 1], { easing: EASE_OUT, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
          return (
            <div
              key={i}
              style={{
                position: 'absolute',
                left: 0,
                bottom,
                width: w,
                height: h - 8,
                background: b.color,
                border: `4px solid ${INK}`,
                borderRadius: 10,
                boxSizing: 'border-box',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontFamily: FONT_BODY,
                fontWeight: 600,
                fontSize: 30,
                color: b.textColor ?? INK,
                opacity: p,
                transform: `translateY(${(1 - p) * 40}px)`,
                boxShadow: '0 6px 14px rgba(40,28,12,0.22)',
              }}
            >
              {b.label}
            </div>
          );
        })}
      </div>
    </Layer>
  );
};
