// network — node-and-route diagram kit for the networking series (short-15: DNS lookup,
// TCP/TLS handshake, DOM/paint). Simple flat glyphs (laptop, DNS server disc, server rack),
// a dashed route connector, a traveling labeled packet dot, a round-trip counter, an
// assembling padlock, and a wireframe->color paint reveal for a mocked-up web page. Frame-based
// only; pairs with lib/browser.tsx (WebBrowserFrame) for the loaded-page shots.
import React from 'react';
import { COLORS } from './brand';
import { FONT_BODY, FONT_DISPLAY, FONT_MONO } from './fonts';

export type NodeKind = 'laptop' | 'resolver' | 'root' | 'tld' | 'rack';

const NODE_COLOR: Record<NodeKind, string> = {
  laptop: '#8fb7c9',
  resolver: COLORS.accent,
  root: COLORS.accent2,
  tld: COLORS.signal,
  rack: '#9aa0a6',
};

// -----------------------------------------------------------------------------
// Glyphs — small flat SVG icons, brand-colored, no photoreal assets needed.
// -----------------------------------------------------------------------------
export const LaptopGlyph: React.FC<{ size?: number; tint?: string }> = ({ size = 110, tint = '#8fb7c9' }) => (
  <svg width={size} height={size * 0.72} viewBox="0 0 100 72" style={{ display: 'block' }}>
    <rect x="8" y="4" width="84" height="54" rx="6" fill="#20242c" stroke="#3c4043" strokeWidth={2} />
    <rect x="16" y="11" width="68" height="40" rx="2" fill="#0d1117" />
    {[0, 1, 2].map((i) => (
      <rect key={i} x={23} y={18 + i * 10} width={26 - (i % 2) * 8} height={5} rx={2.5} fill={i === 1 ? COLORS.warn : tint} opacity={0.92} />
    ))}
    <path d="M2 60 L98 60 L90 70 Q88 72 84 72 L16 72 Q12 72 10 70 Z" fill="#cfd3d8" stroke="#3c4043" strokeWidth={2} />
  </svg>
);

export const ServerNodeGlyph: React.FC<{ color: string; size?: number }> = ({ color, size = 100 }) => (
  <svg width={size} height={size} viewBox="0 0 100 100" style={{ display: 'block' }}>
    <rect x="10" y="10" width="80" height="80" rx="16" fill={`${color}22`} stroke={color} strokeWidth={4} />
    {[0, 1, 2].map((i) => (
      <rect key={i} x="26" y={30 + i * 16} width="48" height="10" rx={5} fill={color} opacity={0.88 - i * 0.14} />
    ))}
  </svg>
);

export const RackGlyph: React.FC<{ size?: number; color?: string }> = ({ size = 100, color = '#9aa0a6' }) => (
  <svg width={size} height={size * 1.15} viewBox="0 0 100 115" style={{ display: 'block' }}>
    <rect x="6" y="4" width="88" height="107" rx="10" fill="#2b2d33" stroke={color} strokeWidth={3} />
    {[0, 1, 2, 3].map((u) => (
      <g key={u}>
        <rect x="14" y={12 + u * 25} width="72" height="19" rx={4} fill="#44464e" stroke={color} strokeWidth={1.6} />
        <circle cx={78} cy={12 + u * 25 + 9.5} r={3} fill="#58e08a" />
      </g>
    ))}
  </svg>
);

const GLYPH_SIZE: Record<NodeKind, number> = { laptop: 110, resolver: 100, root: 100, tld: 100, rack: 100 };

const Glyph: React.FC<{ kind: NodeKind; size: number }> = ({ kind, size }) => {
  if (kind === 'laptop') return <LaptopGlyph size={size} />;
  if (kind === 'rack') return <RackGlyph size={size} color={NODE_COLOR.rack} />;
  return <ServerNodeGlyph color={NODE_COLOR[kind]} size={size} />;
};

// -----------------------------------------------------------------------------
// NetNode — glyph + label (+ optional sub-label), one diagram stop.
// -----------------------------------------------------------------------------
export const NetNode: React.FC<{
  x: number;
  y: number;
  kind: NodeKind;
  label: string;
  sub?: string;
  opacity?: number;
  scale?: number;
}> = ({ x, y, kind, label, sub, opacity = 1, scale = 1 }) => {
  if (opacity <= 0.01) return null;
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        transform: `translate(-50%, -50%) scale(${scale})`,
        opacity,
        textAlign: 'center',
      }}
    >
      <Glyph kind={kind} size={GLYPH_SIZE[kind]} />
      <div
        style={{
          marginTop: 10,
          fontFamily: FONT_MONO,
          fontWeight: 600,
          fontSize: 26,
          letterSpacing: 1.5,
          color: '#ffffff',
          textShadow: '0 2px 10px rgba(0,0,0,0.55)',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </div>
      {sub ? (
        <div style={{ marginTop: 4, fontFamily: FONT_BODY, fontSize: 19, color: NODE_COLOR[kind], fontWeight: 600, whiteSpace: 'nowrap' }}>
          {sub}
        </div>
      ) : null}
    </div>
  );
};

// -----------------------------------------------------------------------------
// DashedConnector — a single vertical dashed route line between two diagram stops.
// -----------------------------------------------------------------------------
export const DashedConnector: React.FC<{
  x: number;
  y1: number;
  y2: number;
  w?: number;
  h?: number;
  color?: string;
  opacity?: number;
}> = ({ x, y1, y2, w = 1080, h = 1920, color = 'rgba(255,255,255,0.35)', opacity = 1 }) => (
  <svg style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }} width={w} height={h}>
    <line x1={x} y1={y1} x2={x} y2={y2} stroke={color} strokeWidth={4} strokeDasharray="3 16" strokeLinecap="round" opacity={opacity} />
  </svg>
);

// -----------------------------------------------------------------------------
// PacketDot — a small glowing dot traveling between two y positions at fixed x,
// 0 <= t <= 1 (hidden outside that range), with an optional label above it.
// -----------------------------------------------------------------------------
export const PacketDot: React.FC<{
  x: number;
  yFrom: number;
  yTo: number;
  t: number;
  label?: string;
  color?: string;
}> = ({ x, yFrom, yTo, t, label, color = COLORS.warn }) => {
  if (t <= 0 || t >= 1) return null;
  const y = yFrom + (yTo - yFrom) * t;
  const pulse = 1 + 0.18 * Math.sin(t * Math.PI);
  return (
    <div style={{ position: 'absolute', left: x, top: y, transform: `translate(-50%, -50%) scale(${pulse})` }}>
      <div style={{ width: 22, height: 22, borderRadius: '50%', background: color, boxShadow: `0 0 26px ${color}` }} />
      {label ? (
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: -38,
            transform: 'translateX(-50%)',
            whiteSpace: 'nowrap',
            fontFamily: FONT_MONO,
            fontWeight: 700,
            fontSize: 22,
            letterSpacing: 1,
            color,
            background: 'rgba(10,10,14,0.78)',
            padding: '5px 12px',
            borderRadius: 8,
          }}
        >
          {label}
        </div>
      ) : null}
    </div>
  );
};

// -----------------------------------------------------------------------------
// BounceCounter — big "N round trips" readout for the handshake beat.
// -----------------------------------------------------------------------------
export const BounceCounter: React.FC<{ n: number; x: number; y: number; opacity?: number }> = ({ n, x, y, opacity = 1 }) => (
  <div style={{ position: 'absolute', left: x, top: y, transform: 'translate(-50%, -50%)', opacity, textAlign: 'center' }}>
    <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 68, color: '#ffffff', textShadow: '0 4px 24px rgba(0,0,0,0.6)' }}>{n}</div>
    <div style={{ fontFamily: FONT_BODY, fontSize: 20, letterSpacing: 3, color: COLORS.warn, textTransform: 'uppercase', marginTop: -8 }}>
      round trip{n === 1 ? '' : 's'}
    </div>
  </div>
);

// -----------------------------------------------------------------------------
// Padlock — shackle draws in with `progress` (0..1); fills solid once `closed`.
// -----------------------------------------------------------------------------
export const Padlock: React.FC<{ x: number; y: number; progress: number; closed?: boolean; size?: number }> = ({
  x,
  y,
  progress,
  closed = false,
  size = 116,
}) => {
  if (progress <= 0.01) return null;
  const shackleLen = 80;
  return (
    <div style={{ position: 'absolute', left: x, top: y, transform: 'translate(-50%, -50%)', opacity: Math.min(1, progress * 1.4) }}>
      <svg width={size} height={size} viewBox="0 0 100 100" style={{ filter: 'drop-shadow(0 6px 18px rgba(0,0,0,0.4))' }}>
        <path
          d="M30 42 V28 Q30 10 50 10 Q70 10 70 28 V42"
          fill="none"
          stroke={COLORS.signal}
          strokeWidth={9}
          strokeLinecap="round"
          strokeDasharray={shackleLen}
          strokeDashoffset={shackleLen * (1 - Math.min(1, progress * 1.3))}
        />
        <rect x="18" y="42" width="64" height="46" rx={10} fill={closed ? COLORS.signal : 'rgba(255,255,255,0.14)'} stroke={COLORS.signal} strokeWidth={6} />
        <circle cx="50" cy="63" r={6} fill={closed ? '#ffffff' : COLORS.signal} opacity={closed ? 1 : 0.6} />
      </svg>
    </div>
  );
};

// -----------------------------------------------------------------------------
// PaintReveal — wireframe/color crossfade-by-wipe for a mocked-up web page: the
// colored layer is clipped by `progress` (0..1) and wipes in left -> right, with
// a thin leading edge glow, over the wireframe skeleton underneath.
// -----------------------------------------------------------------------------
export const PaintReveal: React.FC<{ progress: number; width: number; height: number; wire: React.ReactNode; color: React.ReactNode }> = ({
  progress,
  width,
  height,
  wire,
  color,
}) => (
  <div style={{ position: 'relative', width, height, overflow: 'hidden' }}>
    <div style={{ position: 'absolute', inset: 0 }}>{wire}</div>
    <div style={{ position: 'absolute', inset: 0, clipPath: `inset(0 ${(1 - progress) * 100}% 0 0)` }}>{color}</div>
    {progress > 0.015 && progress < 0.985 ? (
      <div
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: `${progress * 100}%`,
          width: 5,
          background: COLORS.accent,
          boxShadow: `0 0 22px ${COLORS.accent}`,
        }}
      />
    ) : null}
  </div>
);

// -----------------------------------------------------------------------------
// DomNodes — small labeled boxes assembling (staggered) to represent the DOM
// (+ a CSSOM chip) being built, overlaid on the page while it's unpainted.
// -----------------------------------------------------------------------------
const DOM_BOXES = [
  { x: 24, y: 14, w: 150, label: '<html>' },
  { x: 24, y: 62, w: 130, label: '<header>' },
  { x: 180, y: 62, w: 170, label: 'CSSOM' },
  { x: 24, y: 110, w: 110, label: '<main>' },
  { x: 160, y: 110, w: 90, label: '<p>' },
] as const;

export const DomNodes: React.FC<{ frame: number; at: number; stagger?: number; opacity?: number }> = ({ frame, at, stagger = 15, opacity = 1 }) => {
  if (opacity <= 0.01) return null;
  return (
    <div style={{ position: 'absolute', left: 40, top: 30, width: 400, height: 170, opacity }}>
      {DOM_BOXES.map((n, i) => {
        const start = at + i * stagger;
        const f = frame;
        const p = Math.max(0, Math.min(1, (f - start) / 10));
        return (
          <div
            key={n.label}
            style={{
              position: 'absolute',
              left: n.x,
              top: n.y,
              width: n.w,
              opacity: p,
              transform: `scale(${0.85 + 0.15 * p})`,
              background: '#ffffff',
              border: `2px solid ${COLORS.accent}`,
              borderRadius: 8,
              padding: '6px 10px',
              fontFamily: FONT_MONO,
              fontSize: 17,
              color: COLORS.accent,
              fontWeight: 600,
              boxShadow: '0 4px 14px rgba(0,0,0,0.14)',
              whiteSpace: 'nowrap',
            }}
          >
            {n.label}
          </div>
        );
      })}
    </div>
  );
};
