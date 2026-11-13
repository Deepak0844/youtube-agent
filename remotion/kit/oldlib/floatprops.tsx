// floatprops — drawn SVG workshop objects for ai-2 "The Honest Rounding" (and any future
// floating-point / number-precision short): etched glass jugs, a measuring cup, a floating
// holographic numeral readout, a glowing fold-ruler, a brass scrolling terminal. Brand.md
// section 0 fallback ("otherwise use the drawn SVG props") — no AI image/video generation
// in this file. Frame-based only; every idle motion that can appear at BOTH frame 0 and the
// final frame is driven by a WHOLE-CYCLE sine keyed to `totalFrames` (short-13's pattern) so
// the loop reads seamless.
import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import { COLORS, EASINGS } from './brand';
import { FONT_MONO } from './fonts';

const CLAMP = { extrapolateLeft: 'clamp' as const, extrapolateRight: 'clamp' as const };
const svgBase = { width: '100%', display: 'block', overflow: 'visible' } as const;

export const WOOD = { dark: '#3d2a1c', mid: '#5a3d26', light: '#7a5436', plank: '#684933' } as const;
export const BRASS = '#c9a35a';
export const LIQUID = COLORS.signal; // teal — the liquid / holographic glow colour

// whole-cycle progress 0..2π over the full composition, for motion present at both loop ends
const cycle = (frame: number, totalFrames: number, k = 1, phase = 0) => (2 * Math.PI * frame * k) / totalFrames + phase;

// -----------------------------------------------------------------------------
// WorkbenchGlow — warm backdrop: wood-plank gradient + drifting glow blobs + a
// faint dotted grid (brand §5). Blob drift is a whole-cycle sine so frame 0 and
// the last frame read the same.
// -----------------------------------------------------------------------------
export const WorkbenchGlow: React.FC<{ totalFrames: number }> = ({ totalFrames }) => {
  const frame = useCurrentFrame();
  const blob = (cx: number, cy: number, r: number, color: string, k: number, ph: number, amp: number) => {
    const a = cycle(frame, totalFrames, k, ph);
    return (
      <div
        style={{
          position: 'absolute',
          left: cx + Math.sin(a) * amp - r,
          top: cy + Math.cos(a) * amp - r,
          width: r * 2,
          height: r * 2,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${color} 0%, transparent 68%)`,
        }}
      />
    );
  };
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: `linear-gradient(175deg, ${WOOD.mid} 0%, ${WOOD.dark} 60%, #241609 100%)`,
        }}
      />
      {Array.from({ length: 9 }).map((_, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 120 + i * 210,
            height: 2,
            background: 'rgba(0,0,0,0.18)',
          }}
        />
      ))}
      {blob(260, 460, 520, 'rgba(201,163,90,0.20)', 2, 0, 80)}
      {blob(820, 1040, 580, 'rgba(77,184,168,0.14)', 3, 2, 70)}
      {blob(340, 1560, 520, 'rgba(201,163,90,0.14)', 2, 4, 90)}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: 'radial-gradient(rgba(255,235,200,0.05) 1.5px, transparent 1.6px)',
          backgroundSize: '54px 54px',
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'radial-gradient(ellipse 120% 90% at 50% 46%, transparent 50%, rgba(0,0,0,0.55) 100%)',
        }}
      />
    </div>
  );
};

// -----------------------------------------------------------------------------
// GlassJug — etched measuring jug, static mid-pour tableau (a frozen pose reads
// as "pouring" without needing to animate liquid flow frame to frame — that
// also keeps the loop seam pixel-clean). A short tapered stream connects the
// spout toward the cup below it.
// -----------------------------------------------------------------------------
export const GlassJug: React.FC<{
  x: number;
  y: number;
  w: number;
  label: string;
  tilt?: number;
  streamLen?: number;
  flip?: boolean;
}> = ({ x, y, w, label, tilt = 32, streamLen = 150, flip = false }) => (
  <div style={{ position: 'absolute', left: x, top: y, width: w, transform: `scaleX(${flip ? -1 : 1})` }}>
    <div style={{ transform: `rotate(${tilt}deg)`, transformOrigin: '30% 85%' }}>
    <svg viewBox="0 0 160 220" style={svgBase}>
      <path
        d="M 30 30 Q 24 16 40 12 L 70 12 Q 80 12 80 22 L 80 40 Q 128 48 132 110 L 132 178 Q 132 206 104 206 L 46 206 Q 22 206 22 182 L 22 70 Q 22 44 30 30 Z"
        fill="rgba(210,235,238,0.16)"
        stroke="rgba(230,245,248,0.75)"
        strokeWidth={4}
      />
      <path d="M 30 100 L 128 108 L 128 178 Q 128 200 104 200 L 46 200 Q 26 200 26 180 Z" fill={`${LIQUID}55`} />
      <rect x="14" y="40" width="22" height="22" rx="4" fill="rgba(20,16,10,0.72)" stroke={BRASS} strokeWidth={2} transform="rotate(-18 25 51)" />
      <text x="25" y="56" textAnchor="middle" fontFamily={FONT_MONO} fontWeight={700} fontSize="16" fill={BRASS} transform="rotate(-18 25 51)">
        {label}
      </text>
      <path d="M 78 24 L 86 20" stroke="rgba(230,245,248,0.75)" strokeWidth={4} strokeLinecap="round" />
    </svg>
    <div
      style={{
        position: 'absolute',
        left: '58%',
        top: 206,
        width: 10,
        height: streamLen,
        background: `linear-gradient(180deg, ${LIQUID}cc, ${LIQUID}22)`,
        borderRadius: 6,
        transform: 'translateX(-50%) rotate(14deg)',
        boxShadow: `0 0 18px ${LIQUID}77`,
      }}
    />
    </div>
  </div>
);

// -----------------------------------------------------------------------------
// MeasuringCup — graduated glass cup with a settled liquid fill. Surface glow
// breathes on a whole-cycle (safe at both loop ends).
// -----------------------------------------------------------------------------
export const MeasuringCup: React.FC<{ x: number; y: number; w: number; fillPct?: number; totalFrames: number }> = ({
  x,
  y,
  w,
  fillPct = 0.42,
  totalFrames,
}) => {
  const frame = useCurrentFrame();
  const glow = 0.6 + 0.4 * Math.sin(cycle(frame, totalFrames, 4));
  const liquidTop = 196 - fillPct * 160;
  return (
    <div style={{ position: 'absolute', left: x, top: y, width: w }}>
      <svg viewBox="0 0 180 220" style={svgBase}>
        <path
          d="M 24 20 L 156 20 L 140 196 Q 138 212 122 212 L 58 212 Q 42 212 40 196 Z"
          fill="rgba(220,238,240,0.14)"
          stroke="rgba(230,245,248,0.8)"
          strokeWidth={4}
        />
        {[1, 2, 3].map((t) => (
          <line key={t} x1={44 + t * 2} y1={196 - t * 48} x2={58 + t * 2} y2={196 - t * 48} stroke="rgba(230,245,248,0.55)" strokeWidth={2.5} />
        ))}
        <path
          d={`M 41 ${liquidTop} L 139 ${liquidTop} L ${122 + (liquidTop - 196) * 0.1} 206 Q 120 210 110 210 L 70 210 Q 60 210 58 206 Z`}
          fill={`${LIQUID}70`}
        />
        <rect
          x={41}
          y={liquidTop - 3}
          width={98}
          height={6}
          rx={3}
          fill={LIQUID}
          opacity={glow}
          style={{ filter: `drop-shadow(0 0 ${10 * glow}px ${LIQUID})` }}
        />
        <path d="M 156 24 Q 182 30 178 58 Q 174 82 150 86" fill="none" stroke="rgba(230,245,248,0.8)" strokeWidth={4} strokeLinecap="round" />
      </svg>
    </div>
  );
};

// -----------------------------------------------------------------------------
// HoloReadout — floating holographic numeral card. The tail digits (the
// "impossible little tail") sit in the accent colour. Idle bob + glow pulse on
// a whole-cycle so it matches pixel-for-pixel at both ends of the loop.
// -----------------------------------------------------------------------------
export const HoloReadout: React.FC<{
  x: number;
  y: number;
  value: string;
  tailChars?: number;
  size?: number;
  totalFrames: number;
  enterAt?: number;
}> = ({ x, y, value, tailChars = 4, size = 34, totalFrames, enterAt }) => {
  const frame = useCurrentFrame();
  const bob = Math.sin(cycle(frame, totalFrames, 5)) * 6;
  const glow = 0.65 + 0.35 * Math.sin(cycle(frame, totalFrames, 5, 1.2));
  const enter = enterAt === undefined ? 1 : interpolate(frame, [enterAt, enterAt + 14], [0, 1], { ...CLAMP, easing: EASINGS.easeOut });
  const head = value.slice(0, value.length - tailChars);
  const tail = value.slice(value.length - tailChars);
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y + bob,
        transform: `translate(-50%, -50%) scale(${0.92 + 0.08 * enter})`,
        opacity: enter,
        background: 'rgba(16,12,8,0.62)',
        border: `2px solid ${LIQUID}88`,
        borderRadius: 18,
        padding: '18px 26px',
        boxShadow: `0 0 ${26 * glow}px ${LIQUID}55, 0 14px 40px rgba(0,0,0,0.4)`,
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ fontFamily: FONT_MONO, fontWeight: 700, fontSize: size, color: '#f3efe6' }}>{head}</span>
      <span style={{ fontFamily: FONT_MONO, fontWeight: 700, fontSize: size, color: COLORS.warn, textShadow: `0 0 ${14 * glow}px ${COLORS.warn}` }}>
        {tail}
      </span>
    </div>
  );
};

// -----------------------------------------------------------------------------
// DigitGhostThread — a few trailing digits peeling off the cup rim and
// drifting up, fading as they go. One-shot within its own Sequence (not a
// loop boundary), so a simple local-frame stagger is fine.
// -----------------------------------------------------------------------------
export const DigitGhostThread: React.FC<{ x: number; y: number; text: string; at?: number }> = ({ x, y, text, at = 0 }) => {
  const frame = useCurrentFrame();
  const chars = text.split('');
  return (
    <div style={{ position: 'absolute', left: x, top: y }}>
      {chars.map((c, i) => {
        const start = at + i * 6;
        const p = interpolate(frame, [start, start + 50], [0, 1], { ...CLAMP, easing: EASINGS.easeOut });
        if (p <= 0.01) return null;
        return (
          <span
            key={i}
            style={{
              position: 'absolute',
              left: i * 22,
              top: -p * 130,
              fontFamily: FONT_MONO,
              fontWeight: 700,
              fontSize: 30,
              color: COLORS.warn,
              opacity: (1 - p) * 0.9,
              textShadow: `0 0 12px ${COLORS.warn}`,
            }}
          >
            {c}
          </span>
        );
      })}
    </div>
  );
};

// -----------------------------------------------------------------------------
// FoldTape — a long glowing measuring tape that halves itself at staged cue
// frames (clean landing on a tick), or frays on an attempted tenth-fold.
// -----------------------------------------------------------------------------
export type FoldStage = { atLocal: number; label: string; fail?: boolean };

export const FoldTape: React.FC<{ x: number; y: number; w: number; stages: FoldStage[] }> = ({ x, y, w, stages }) => {
  const frame = useCurrentFrame();
  let width = w;
  let landed: { label: string; fail?: boolean }[] = [];
  stages.forEach((s) => {
    if (frame >= s.atLocal) {
      width = s.fail ? width : width / 2;
      landed = [...landed, { label: s.label, fail: s.fail }];
    }
  });
  const activeFail = landed.length > 0 && landed[landed.length - 1].fail;
  const flicker = activeFail ? 0.45 + 0.55 * Math.abs(Math.sin(frame * 0.9)) : 1;

  return (
    <div style={{ position: 'absolute', left: x, top: y, width: w, height: 70 }}>
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 26,
          width,
          height: 18,
          borderRadius: 9,
          background: `linear-gradient(90deg, ${LIQUID}, ${BRASS})`,
          opacity: activeFail ? flicker : 1,
          boxShadow: activeFail ? `0 0 ${18 * flicker}px ${COLORS.danger}` : `0 0 16px ${LIQUID}99`,
          clipPath: activeFail
            ? `polygon(0 0, 97% 0, 100% 35%, 94% 55%, 100% 70%, 92% 100%, 0 100%)`
            : undefined,
        }}
      />
      {Array.from({ length: 9 }).map((_, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            left: (width / 8) * i,
            top: 16,
            width: 2,
            height: 38,
            background: 'rgba(255,255,255,0.35)',
          }}
        />
      ))}
      {landed.map((l, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            left: Math.max(0, width - 4),
            top: 0,
            transform: 'translateX(-50%)',
            fontFamily: FONT_MONO,
            fontWeight: 700,
            fontSize: 24,
            color: l.fail ? COLORS.danger : '#f3efe6',
            opacity: i === landed.length - 1 ? 1 : 0,
            whiteSpace: 'nowrap',
          }}
        >
          {l.label}
        </div>
      ))}
    </div>
  );
};

// -----------------------------------------------------------------------------
// BrassTerminal — a brass-rimmed glass readout scrolling the literal stored
// decimal expansions, with two glowing marker dots drifting together.
// -----------------------------------------------------------------------------
export const BrassTerminal: React.FC<{
  x: number;
  y: number;
  w: number;
  h: number;
  lineA: string;
  lineB: string;
  converge: number; // 0..1
}> = ({ x, y, w, h, lineA, lineB, converge }) => {
  const mid = w / 2;
  const ax = 70 + (mid - 70) * converge;
  const bx = w - 70 - (mid - 70) * converge;
  return (
    <div style={{ position: 'absolute', left: x, top: y, width: w, height: h }}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 20,
          background: `linear-gradient(175deg, ${BRASS}, #7a5e2e)`,
          padding: 10,
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{ width: '100%', height: '100%', borderRadius: 12, background: '#0b1310', overflow: 'hidden', position: 'relative' }}>
          <div
            style={{
              position: 'absolute',
              top: 18,
              left: 20,
              right: 20,
              fontFamily: FONT_MONO,
              fontSize: 17,
              lineHeight: 1.5,
              color: `${LIQUID}cc`,
              wordBreak: 'break-all',
            }}
          >
            0.1 = {lineA}
          </div>
          <div
            style={{
              position: 'absolute',
              bottom: 18,
              left: 20,
              right: 20,
              fontFamily: FONT_MONO,
              fontSize: 17,
              lineHeight: 1.5,
              color: `${COLORS.warn}cc`,
              wordBreak: 'break-all',
            }}
          >
            0.2 = {lineB}
          </div>
          <div style={{ position: 'absolute', left: ax, top: '50%', width: 16, height: 16, borderRadius: 8, background: LIQUID, boxShadow: `0 0 20px ${LIQUID}`, transform: 'translate(-50%,-50%)' }} />
          <div style={{ position: 'absolute', left: bx, top: '50%', width: 16, height: 16, borderRadius: 8, background: COLORS.warn, boxShadow: `0 0 20px ${COLORS.warn}`, transform: 'translate(-50%,-50%)' }} />
        </div>
      </div>
    </div>
  );
};
