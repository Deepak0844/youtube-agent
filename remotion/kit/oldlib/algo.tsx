// Algorithm-race kit — instrumented sorts replayed frame-deterministically.
// Every op on screen is a REAL comparison/swap the algorithm performed on the same
// seeded shuffle; a race is honest by construction. Replay: opsDone = elapsed × opsPerSec.
import React from 'react';
import { useCurrentFrame } from 'remotion';
import { FONT_BODY, FONT_DISPLAY, FONT_MONO } from './fonts';
import { EASE_OUT, prog } from './shorts';

// deterministic shuffle (LCG + Fisher-Yates) — Math.random is banned in renders
export const seededShuffle = (n: number, seed: number): number[] => {
  const arr = Array.from({ length: n }, (_, i) => i + 1);
  let s = (seed >>> 0) || 1;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};

export type SortOp = { a: number[]; hi: [number, number]; swap: boolean };

// classic bubble sort, one op per neighbor comparison (swap folded into the op)
export const bubbleSteps = (initial: number[]): SortOp[] => {
  const a = [...initial];
  const ops: SortOp[] = [];
  for (let i = 0; i < a.length - 1; i++) {
    for (let j = 0; j < a.length - 1 - i; j++) {
      const doSwap = a[j] > a[j + 1];
      if (doSwap) [a[j], a[j + 1]] = [a[j + 1], a[j]];
      ops.push({ a: [...a], hi: [j, j + 1], swap: doSwap });
    }
  }
  return ops;
};

// quicksort (Lomuto), one op per pivot comparison + one per pivot placement
export const quickSteps = (initial: number[]): SortOp[] => {
  const a = [...initial];
  const ops: SortOp[] = [];
  const qs = (lo: number, hi: number) => {
    if (lo >= hi) return;
    const pivot = a[hi];
    let i = lo - 1;
    for (let j = lo; j < hi; j++) {
      const doSwap = a[j] < pivot;
      if (doSwap) {
        i++;
        [a[i], a[j]] = [a[j], a[i]];
      }
      ops.push({ a: [...a], hi: [j, hi], swap: doSwap });
    }
    [a[i + 1], a[hi]] = [a[hi], a[i + 1]];
    ops.push({ a: [...a], hi: [i + 1, hi], swap: true });
    qs(lo, i);
    qs(i + 2, hi);
  };
  qs(0, a.length - 1);
  return ops;
};

// state after opsDone operations (scrub-safe: pure function of the step list)
export const raceState = (initial: number[], steps: SortOp[], opsDone: number) => {
  const k = Math.max(0, Math.min(steps.length, Math.floor(opsDone)));
  if (k === 0) return { values: initial, hi: null as [number, number] | null, ops: 0, done: false };
  const op = steps[k - 1];
  return { values: op.a, hi: k >= steps.length ? null : op.hi, ops: k, done: k >= steps.length };
};

// =============================================================================
// BAR PANEL — one racer: bars + label chip + live op counter + DONE badge.
// =============================================================================
export const BarPanel: React.FC<{
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  color: string;
  values: number[];
  max: number;
  hi: [number, number] | null;
  ops: number;
  labelAt?: number; // local frame the label/counter pop in (negative = warm)
  doneAtFrame?: number; // local frame the DONE badge pops (omit = never)
  doneText?: string;
  good?: string;
}> = ({ x, y, w, h, label, color, values, max, hi, ops, labelAt = 0, doneAtFrame, doneText = 'DONE', good = '#4db8a8' }) => {
  const frame = useCurrentFrame();
  const labelIn = EASE_OUT(prog(frame, labelAt, labelAt + 10));
  const isDone = doneAtFrame !== undefined && frame >= doneAtFrame;
  const badgeIn = doneAtFrame === undefined ? 0 : EASE_OUT(prog(frame, doneAtFrame, doneAtFrame + 10));
  const pad = 22;
  const headH = 56;
  const n = values.length;
  const gap = 5;
  const bw = (w - pad * 2 - (n - 1) * gap) / n;
  const barArea = h - headH - pad * 2;
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: w,
        height: h,
        background: 'rgba(255,255,255,0.035)',
        border: `2px solid ${isDone ? good + '88' : 'rgba(255,255,255,0.12)'}`,
        borderRadius: 24,
      }}
    >
      {/* label + counter */}
      <div style={{ position: 'absolute', top: 16, left: pad, right: pad, display: 'flex', justifyContent: 'space-between', opacity: labelIn }}>
        <span style={{ fontFamily: FONT_BODY, fontWeight: 600, fontSize: 32, letterSpacing: 4, color, textTransform: 'uppercase' }}>{label}</span>
        <span style={{ fontFamily: FONT_MONO, fontWeight: 700, fontSize: 32, color: 'rgba(255,255,255,0.75)' }}>{ops} ops</span>
      </div>
      {/* bars */}
      {values.map((v, i) => {
        const active = !isDone && hi !== null && (i === hi[0] || i === hi[1]);
        const bh = Math.max(6, (v / max) * barArea);
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: pad + i * (bw + gap),
              bottom: pad,
              width: bw,
              height: bh,
              borderRadius: 5,
              background: isDone ? good : active ? color : 'rgba(255,255,255,0.72)',
            }}
          />
        );
      })}
      {/* DONE badge */}
      {badgeIn > 0.01 ? (
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: `translate(-50%, -50%) rotate(-5deg) scale(${1.5 - 0.5 * badgeIn})`,
            opacity: badgeIn,
            fontFamily: FONT_DISPLAY,
            fontWeight: 700,
            fontSize: 58,
            letterSpacing: 4,
            color: good,
            border: `5px solid ${good}`,
            borderRadius: 14,
            padding: '6px 24px',
            background: 'rgba(10,12,14,0.8)',
            whiteSpace: 'nowrap',
          }}
        >
          {doneText}
        </div>
      ) : null}
    </div>
  );
};

// =============================================================================
// BINARY SEARCH — a REAL guessing game over 1..n, replayed frame-deterministically.
// The board always shows the live interval zoomed to full width, so 1,000,000 → 1
// reads as ONE continuous zoom. Every guess/verdict is the algorithm's actual step.
// =============================================================================
export type SearchStep = { lo: number; hi: number; mid: number; dir: -1 | 0 | 1 }; // dir 1 = too low, -1 = too high

export const binarySearchSteps = (n: number, target: number): SearchStep[] => {
  const out: SearchStep[] = [];
  let lo = 1;
  let hi = n;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const dir = mid === target ? 0 : mid < target ? 1 : -1;
    out.push({ lo, hi, mid, dir });
    if (dir === 0) break;
    if (dir === 1) lo = mid + 1;
    else hi = mid - 1;
  }
  return out;
};

export const fmt = (v: number) => Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export type SearchView = {
  i: number;
  step: SearchStep;
  dispLo: number; // left edge of the zoomed window (cell coordinates)
  dispHi: number; // right edge (exclusive)
  keepLo: number; // surviving interval [keepLo, keepHi)
  keepHi: number;
  markerP: number; // 0..1 guess marker drop-in
  markerOut: number; // 0..1 marker fade as the zoom starts
  verdictP: number;
  dimP: number; // eliminated half fading out
  guesses: number;
  left: number; // candidates remaining, as the counter should read
  done: boolean;
  allSizes: number[]; // candidates at the moment of each guess
};

// t = frames since the first guess. durOf(i) = frames the i-th guess takes.
export const searchViewAt = (steps: SearchStep[], t: number, durOf: (i: number) => number): SearchView => {
  let i = 0;
  let start = 0;
  while (i < steps.length - 1 && t >= start + durOf(i)) {
    start += durOf(i);
    i++;
  }
  const p = Math.max(0, Math.min(1, (t - start) / durOf(i)));
  const done = t >= start + durOf(i) && i === steps.length - 1;
  const s = steps[i];
  const keepLo = s.dir === 1 ? s.mid + 1 : s.dir === 0 ? s.mid : s.lo;
  const keepHi = s.dir === -1 ? s.mid : s.dir === 0 ? s.mid + 1 : s.hi + 1;
  const zoomP = EASE_INOUT_LOCAL(prog(p, 0.82, 1));
  const dimP = prog(p, 0.62, 0.8);
  const markerP = EASE_OUT(prog(p, 0, 0.2));
  return {
    i,
    step: s,
    dispLo: s.lo + (keepLo - s.lo) * zoomP,
    dispHi: s.hi + 1 + (keepHi - (s.hi + 1)) * zoomP,
    keepLo,
    keepHi,
    markerP: t < 0 ? 0 : markerP,
    markerOut: s.dir === 0 ? 0 : prog(p, 0.78, 0.9),
    verdictP: t < 0 ? 0 : prog(p, 0.4, 0.55),
    dimP,
    guesses: t < 0 ? 0 : i + (markerP > 0.5 ? 1 : 0),
    left: dimP > 0.5 ? keepHi - keepLo : s.hi + 1 - s.lo,
    done,
    allSizes: steps.map((st) => st.hi + 1 - st.lo),
  };
};

const EASE_INOUT_LOCAL = (x: number) => x * x * (3 - 2 * x); // smoothstep

// The board: counters, dot field (each dot = n/1000 numbers), zoomed range bar with the
// guess marker and verdict pill. Pure function of `view` (+ linear-scan mode).
export const RangeBoard: React.FC<{
  n: number;
  target: number;
  view: SearchView;
  y0: number;
  scan?: { p: number }; // linear-scan mode: marker sweeps left→right, counter = numbers tried
  pill?: { text: string; color: string };
  opacity?: number;
}> = ({ n, target, view, y0, scan, pill, opacity = 1 }) => {
  const X0 = 70;
  const W = 940;
  const GOLD = '#f5d76e';
  const INDIGO = '#6366F1';
  const TEAL = '#4db8a8';
  const PINK = '#e8879f';
  const span = Math.max(1, view.dispHi - view.dispLo);
  const px = (v: number) => X0 + (W * (v - view.dispLo)) / span;
  const s = view.step;
  const elimLo: [number, number] = s.dir === 1 ? [s.lo, s.mid + 1] : s.dir === -1 ? [s.mid, s.hi + 1] : [s.lo, s.mid];
  const elimHi: [number, number] = s.dir === 0 ? [s.mid + 1, s.hi + 1] : [0, 0];
  const dimOp = 1 - view.dimP;
  const found = view.done && !scan;
  const guessesShown = scan ? Math.floor(n * scan.p) : view.guesses;
  const leftShown = scan ? n : view.left;
  const markerX = scan ? X0 + W * scan.p : px(s.mid + 0.5);
  const markerOp = scan ? 1 : view.markerP * (1 - view.markerOut);
  const markerLabel = scan ? fmt(guessesShown) : fmt(s.mid);
  const verdict = scan
    ? pill
    : view.verdictP > 0.01
      ? s.dir === 1
        ? { text: `${fmt(s.mid)}  ·  TOO LOW`, color: PINK }
        : s.dir === -1
          ? { text: `${fmt(s.mid)}  ·  TOO HIGH`, color: GOLD }
          : { text: `${fmt(s.mid)}  ·  FOUND`, color: TEAL }
      : pill;

  // --- dot field geometry: 100 cols x 10 rows = 1000 dots, row-major, dot d covers [d*per+1, (d+1)*per+1)
  const COLS = 50;
  const ROWS = 20;
  const DOTS = COLS * ROWS;
  const per = n / DOTS;
  const stepX = W / COLS;
  const stepY = 15;
  const midDot = Math.min(DOTS - 1, Math.floor((s.mid - 1) / per));
  const targetDot = Math.min(DOTS - 1, Math.floor((target - 1) / per));
  const overlaps = (d: number, lo: number, hiEx: number) => d * per + 1 < hiEx && (d + 1) * per + 1 > lo;
  const dotY = y0 + 170;
  const barTop = y0 + 600;

  const counter = (label: string, value: string, x: number, color: string) => (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y0,
        width: 450,
        height: 140,
        background: 'linear-gradient(160deg, rgba(24,30,42,0.96), rgba(12,14,20,0.96))',
        border: `2px solid ${color}55`,
        borderLeft: `10px solid ${color}`,
        borderRadius: 18,
        padding: '16px 26px',
        boxShadow: `0 14px 44px rgba(0,0,0,0.45), 0 0 40px ${color}18`,
      }}
    >
      <div style={{ fontFamily: FONT_BODY, fontWeight: 600, fontSize: 26, letterSpacing: 3, color, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontFamily: FONT_MONO, fontWeight: 700, fontSize: 64, color: '#fff', marginTop: 4, lineHeight: 1.1 }}>{value}</div>
    </div>
  );
  return (
    <div style={{ position: 'absolute', inset: 0, opacity }}>
      {counter('Guesses', fmt(guessesShown), X0, found ? TEAL : GOLD)}
      {counter('Numbers left', fmt(leftShown), X0 + 490, found ? TEAL : INDIGO)}

      {/* dot field — each dot is n/1000 numbers; the eliminated half ripples out from the guess */}
      <svg style={{ position: 'absolute', left: 0, top: dotY, width: 1080, height: ROWS * stepY + 12 }} viewBox={`0 0 1080 ${ROWS * stepY + 12}`}>
        {Array.from({ length: DOTS }, (_, d) => {
          const cx = X0 + (d % COLS) * stepX + stepX / 2;
          const cy = Math.floor(d / COLS) * stepY + 8;
          let color = INDIGO;
          let op = 1;
          let r = 5.2;
          if (scan) {
            const swept = (d + 0.5) / DOTS <= scan.p;
            color = swept ? PINK : INDIGO;
            op = swept ? 1 : 0.5;
          } else {
            const wasAlive = overlaps(d, s.lo, s.hi + 1);
            const nowAlive = overlaps(d, view.keepLo, view.keepHi);
            if (!wasAlive) op = 0.09;
            else if (!nowAlive) {
              // ripple: dots nearer the guess fade first
              const dist = Math.abs(d - midDot) / DOTS;
              const t = Math.max(0, Math.min(1, view.dimP * 1.7 - dist * 1.4));
              op = 1 - 0.9 * t;
              r = 5.2 - 2.4 * t;
            }
            if (found && d === targetDot) {
              color = TEAL;
              r = 8;
            } else if (d === midDot && markerOp > 0.05 && wasAlive) {
              color = GOLD;
              r = 7;
            }
          }
          return <circle key={d} cx={cx} cy={cy} r={r} fill={color} opacity={op} />;
        })}
      </svg>
      <div style={{ position: 'absolute', left: X0, top: dotY + ROWS * stepY + 14, width: W, display: 'flex', justifyContent: 'space-between', fontFamily: FONT_MONO, fontSize: 22, color: 'rgba(255,255,255,0.45)' }}>
        <span>1</span>
        <span>each dot = {fmt(per)} numbers</span>
        <span>{fmt(n)}</span>
      </div>

      {/* zoomed range bar */}
      <div style={{ position: 'absolute', left: X0, top: barTop, width: W, height: 150, borderRadius: 20, overflow: 'hidden', background: 'rgba(255,255,255,0.07)', border: '2px solid rgba(255,255,255,0.14)', boxShadow: '0 18px 50px rgba(0,0,0,0.4)' }}>
        {scan ? (
          <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: W * scan.p, background: `${PINK}88` }} />
        ) : (
          <>
            <div style={{ position: 'absolute', top: 0, bottom: 0, left: px(view.keepLo) - X0, width: px(view.keepHi) - px(view.keepLo), background: found ? TEAL : `linear-gradient(180deg, #7a7df5, ${INDIGO})` }} />
            <div style={{ position: 'absolute', top: 0, bottom: 0, left: px(elimLo[0]) - X0, width: px(elimLo[1]) - px(elimLo[0]), background: INDIGO, opacity: dimOp }} />
            {s.dir === 0 ? (
              <div style={{ position: 'absolute', top: 0, bottom: 0, left: px(elimHi[0]) - X0, width: px(elimHi[1]) - px(elimHi[0]), background: INDIGO, opacity: dimOp }} />
            ) : null}
          </>
        )}
      </div>
      {/* guess marker */}
      {markerOp > 0.01 ? (
        <>
          <div style={{ position: 'absolute', left: Math.min(Math.max(markerX, X0 + 2), X0 + W - 2) - 3, top: barTop - 20, width: 6, height: 190, borderRadius: 3, background: GOLD, opacity: markerOp, boxShadow: `0 0 24px ${GOLD}aa` }} />
          <div
            style={{
              position: 'absolute',
              left: Math.min(Math.max(markerX, X0 + 120), X0 + W - 120) - 120,
              top: barTop - 76,
              width: 240,
              textAlign: 'center',
              fontFamily: FONT_MONO,
              fontWeight: 700,
              fontSize: 40,
              color: GOLD,
              opacity: markerOp,
            }}
          >
            {markerLabel}
          </div>
        </>
      ) : null}
      {/* ends of the zoomed window */}
      {!scan ? (
        <div style={{ position: 'absolute', left: X0, top: barTop + 164, width: W, display: 'flex', justifyContent: 'space-between', fontFamily: FONT_MONO, fontSize: 28, color: 'rgba(255,255,255,0.6)' }}>
          <span>{fmt(view.dispLo)}</span>
          <span>{fmt(view.dispHi - 1)}</span>
        </div>
      ) : null}

      {/* verdict pill */}
      {verdict ? (
        <div style={{ position: 'absolute', left: 0, right: 0, top: barTop + 224, display: 'flex', justifyContent: 'center' }}>
          <div
            style={{
              fontFamily: FONT_MONO,
              fontWeight: 700,
              fontSize: 40,
              letterSpacing: 2,
              color: verdict.color,
              border: `3px solid ${verdict.color}`,
              borderRadius: 999,
              padding: '10px 34px',
              background: 'rgba(10,12,16,0.8)',
              boxShadow: `0 0 36px ${verdict.color}33`,
            }}
          >
            {verdict.text}
          </div>
        </div>
      ) : null}

    </div>
  );
};
