// Chat-UI kit — a phone message thread, a glowing fixed-width "context window" frame
// overlaid on it, and a token-strip (algo.tsx-style cells) with a sliding highlighted
// range + eviction/dim transitions. Seeds the AI-mechanics series (short-18+).
import React from 'react';
import { useCurrentFrame } from 'remotion';
import * as chroma from 'chroma-js';
import { FONT_BODY, FONT_MONO } from './fonts';
import { EASE_OUT, prog } from './shorts';

export type Bubble = { text: string; from: 'user' | 'ai' };

// =============================================================================
// PHONE SHELL — rounded device frame + status/header bar. Content is clipped to
// the area below the header so bubbles scrolled "above" the thread crop cleanly.
// =============================================================================
export const PhoneShell: React.FC<{
  x: number;
  y: number;
  w: number;
  h: number;
  headerH: number;
  title?: string;
  children: React.ReactNode;
}> = ({ x, y, w, h, headerH, title = 'Messages', children }) => (
  <div
    style={{
      position: 'absolute',
      left: x,
      top: y,
      width: w,
      height: h,
      borderRadius: 42,
      background: '#15181f',
      border: '2px solid rgba(255,255,255,0.14)',
      boxShadow: '0 30px 90px rgba(0,0,0,0.5)',
      overflow: 'hidden',
    }}
  >
    {/* header */}
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: w,
        height: headerH,
        background: 'linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.02))',
        borderBottom: '1px solid rgba(255,255,255,0.1)',
        display: 'flex',
        alignItems: 'center',
        gap: 18,
        padding: '0 32px',
        zIndex: 3,
      }}
    >
      <div
        style={{
          width: 54,
          height: 54,
          borderRadius: '50%',
          background: 'linear-gradient(140deg, #6366F1, #9b7cc4)',
        }}
      />
      <div>
        <div style={{ fontFamily: FONT_BODY, fontWeight: 600, fontSize: 30, color: '#fff' }}>{title}</div>
        <div style={{ fontFamily: FONT_BODY, fontWeight: 500, fontSize: 20, color: 'rgba(255,255,255,0.45)' }}>online</div>
      </div>
    </div>
    {/* clipped content region */}
    <div style={{ position: 'absolute', left: 0, top: headerH, width: w, height: h - headerH, overflow: 'hidden' }}>
      {children}
    </div>
  </div>
);

// Thin scroll track + thumb near the bottom — "there's a lot more above" affordance.
export const ScrollTrack: React.FC<{ x: number; y: number; h: number; thumbFrac?: number; thumbSize?: number }> = ({
  x,
  y,
  h,
  thumbFrac = 0.88,
  thumbSize = 64,
}) => (
  <div style={{ position: 'absolute', left: x, top: y, width: 6, height: h, borderRadius: 3, background: 'rgba(255,255,255,0.07)' }}>
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: (h - thumbSize) * thumbFrac,
        width: 6,
        height: thumbSize,
        borderRadius: 3,
        background: 'rgba(255,255,255,0.28)',
      }}
    />
  </div>
);

// =============================================================================
// CHAT BUBBLE — one message, aligned by sender. `highlight` 0..1 brightens it
// (the "resent every turn" pulse); `fade` dims the whole bubble (the faded
// out-of-window bubble, or a de-emphasized row in a mini panel).
// =============================================================================
export const ChatBubble: React.FC<{
  text: string;
  from: 'user' | 'ai';
  x: number;
  y: number;
  w: number;
  h: number;
  opacity?: number;
  highlight?: number;
  fontSize?: number;
}> = ({ text, from, x, y, w, h, opacity = 1, highlight = 0, fontSize = 29 }) => {
  const base = from === 'user' ? '#6366F1' : '#2a2f3a';
  const bg = highlight > 0.01 ? chroma.mix(base, '#f5d76e', highlight * 0.55).hex() : base;
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: w,
        minHeight: h,
        display: 'flex',
        alignItems: 'center',
        opacity,
        boxSizing: 'border-box',
        padding: '18px 26px',
        borderRadius: from === 'user' ? '22px 22px 6px 22px' : '22px 22px 22px 6px',
        background: bg,
        boxShadow: highlight > 0.01 ? `0 0 ${18 * highlight}px rgba(245,215,110,${0.5 * highlight})` : 'none',
      }}
    >
      <span style={{ fontFamily: FONT_BODY, fontWeight: 500, fontSize, lineHeight: 1.28, color: '#fff' }}>{text}</span>
    </div>
  );
};

// Sweep-highlight progress for a bubble at `rank` (0 = topmost/oldest of the group,
// higher = lower/newer), given a list of pulse trigger frames. Each pulse washes
// top-to-bottom across the group — a visual for "the whole thing gets resent."
export const resendHighlight = (frame: number, rank: number, pulses: number[], staggerF = 5, riseF = 10, fallF = 16): number => {
  let m = 0;
  pulses.forEach((p) => {
    const start = p + rank * staggerF;
    const v = prog(frame, start, start + riseF) - prog(frame, start + riseF, start + riseF + fallF);
    m = Math.max(m, v);
  });
  return Math.max(0, Math.min(1, m));
};

// =============================================================================
// WINDOW FRAME — the glowing fixed-width rectangle bounding the "in context"
// bubbles. A label slot sits centered on the top border (swap its text/color by
// cue — no layout shift between "RESENT EVERY TURN" and the stat chip).
// =============================================================================
export const WindowFrame: React.FC<{
  x: number;
  y: number;
  w: number;
  h: number;
  color?: string;
  labelText?: string;
  labelColor?: string;
  labelOpacity?: number;
}> = ({ x, y, w, h, color = '#6366F1', labelText, labelColor = '#6366F1', labelOpacity = 0 }) => (
  <>
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: w,
        height: h,
        borderRadius: 26,
        border: `3px solid ${color}`,
        boxShadow: `0 0 46px ${color}66, inset 0 0 34px ${color}22`,
        pointerEvents: 'none',
      }}
    />
    {labelText && labelOpacity > 0.01 ? (
      <div
        style={{
          position: 'absolute',
          left: x,
          top: y,
          width: w,
          display: 'flex',
          justifyContent: 'center',
          transform: 'translateY(-50%)',
          opacity: labelOpacity,
          pointerEvents: 'none',
        }}
      >
        <div
          style={{
            fontFamily: FONT_MONO,
            fontWeight: 700,
            fontSize: 21,
            letterSpacing: 2,
            color: '#0d0f14',
            background: labelColor,
            borderRadius: 999,
            padding: '9px 22px',
            whiteSpace: 'nowrap',
            boxShadow: `0 8px 28px ${labelColor}55`,
          }}
        >
          {labelText}
        </div>
      </div>
    ) : null}
  </>
);

// =============================================================================
// TOKEN STRIP — a row of fixed cells (algo.tsx-style). The highlighted-window
// outline slides right by `tickFrames.length` steps; the leftmost cells at each
// tick DISSOLVE (clean, fast opacity drop — eviction); a separate trailing band
// DIMS (slow desaturate ramp — context rot). The two must look different.
// =============================================================================
export const TokenStrip: React.FC<{
  x: number;
  y: number;
  w: number;
  cellCount?: number;
  tickFrames: number[];
  dimAt?: number; // frame context-rot dimming begins
  dimBandCells?: number; // how many surviving-but-aging cells dim
  opacity?: number;
  color?: string;
}> = ({ x, y, w, cellCount = 56, tickFrames, dimAt, dimBandCells = 11, opacity = 1, color = '#6366F1' }) => {
  const frame = useCurrentFrame();
  const gap = 4;
  const cellW = (w - gap * (cellCount - 1)) / cellCount;
  const cellH = 46;
  const evictedCount = tickFrames.length;
  const DIM = '#5a5f6b';

  // the highlight-window outline creeps right by one cell-step per tick
  const slideSteps = tickFrames.reduce((acc, t) => acc + prog(frame, t - 6, t + 6), 0);
  const slideX = slideSteps * (cellW + gap);

  return (
    <div style={{ position: 'absolute', left: x, top: y, width: w, opacity }}>
      {/* sliding window outline */}
      <div
        style={{
          position: 'absolute',
          left: slideX - 6,
          top: -6,
          width: cellCount * cellW + (cellCount - 1) * gap - slideX + 12,
          height: cellH + 12,
          borderRadius: 12,
          border: `2px solid ${color}aa`,
          boxShadow: `0 0 24px ${color}44`,
        }}
      />
      {Array.from({ length: cellCount }, (_, i) => {
        // eviction: the i-th of the first `evictedCount` cells dissolves out at its tick
        let op = 1;
        if (i < evictedCount) {
          op = 1 - prog(frame, tickFrames[i], tickFrames[i] + 10);
        } else if (i >= cellCount - evictedCount) {
          // the newest cells fade in one per tick, mirroring the eviction on the left
          const tickIdx = i - (cellCount - evictedCount);
          op = prog(frame, tickFrames[tickIdx], tickFrames[tickIdx] + 10);
        }
        // context rot: a trailing band (just past the evicted cells) slowly dims + desaturates
        let fillColor = color;
        if (dimAt !== undefined && i >= evictedCount && i < evictedCount + dimBandCells) {
          const t = prog(frame, dimAt + (i - evictedCount) * 4, dimAt + (i - evictedCount) * 4 + 90);
          fillColor = chroma.mix(color, DIM, t * 0.82).hex();
          op *= 1 - t * 0.35;
        }
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: i * (cellW + gap),
              top: 0,
              width: cellW,
              height: cellH,
              borderRadius: 4,
              background: fillColor,
              opacity: op,
            }}
          />
        );
      })}
    </div>
  );
};

// =============================================================================
// MINI CHAT PANEL — compact bordered panel of short rows, used by the TWIST's
// "what you see" vs "what it sees" split. Rows can be individually faded.
// =============================================================================
export const MiniChatPanel: React.FC<{
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  color: string;
  rows: { text: string; from: 'user' | 'ai'; faded?: boolean }[];
  opacity?: number;
}> = ({ x, y, w, h, title, color, rows, opacity = 1 }) => {
  const rowH = (h - 70) / rows.length;
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: w,
        height: h,
        opacity,
        borderRadius: 22,
        background: 'rgba(16,18,24,0.92)',
        border: `2px solid ${color}55`,
        boxShadow: `0 20px 60px rgba(0,0,0,0.45)`,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: w,
          height: 58,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderBottom: `1px solid ${color}44`,
          background: `${color}1a`,
        }}
      >
        <span style={{ fontFamily: FONT_MONO, fontWeight: 700, fontSize: 22, letterSpacing: 2, color }}>{title}</span>
      </div>
      {rows.map((r, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            left: 16,
            top: 70 + i * rowH,
            width: w - 32,
            height: rowH - 8,
            display: 'flex',
            alignItems: 'center',
            justifyContent: r.from === 'user' ? 'flex-end' : 'flex-start',
            opacity: r.faded ? 0.3 : 1,
          }}
        >
          <div
            style={{
              maxWidth: '82%',
              padding: '8px 14px',
              borderRadius: 12,
              background: r.from === 'user' ? '#6366F1' : '#2a2f3a',
              fontFamily: FONT_BODY,
              fontWeight: 500,
              fontSize: 17,
              color: '#fff',
              lineHeight: 1.2,
            }}
          >
            {r.text}
          </div>
        </div>
      ))}
    </div>
  );
};

export { EASE_OUT, prog };
