import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import * as chroma from 'chroma-js';
import { Captions, Kicker, ProgressBar, ShortsBackdrop, prog } from '../../lib/shorts';
import { COLORS, EASINGS } from '../../brand';
import { FONT_BODY, FONT_DISPLAY, FONT_MONO } from '../../fonts';
import { WebBrowserFrame } from '../../lib/browser';
import { LaptopGlyph, RackGlyph } from '../../lib/network';
import { VO } from './vo.gen';

// =============================================================================
// COMPOSITION CONFIG
// =============================================================================
export const compositionConfig = {
  id: 'Short17AdBlocker',
  durationInSeconds: 41,
  fps: 30,
  width: 1080,
  height: 1920,
};

// =============================================================================
// STYLE CONSTANTS
// =============================================================================
const INDIGO = COLORS.accent;
const VIOLET = COLORS.accent2;
const TEAL = COLORS.signal;
const WARN = COLORS.warn;
const PINK = COLORS.danger;
const DIM = '#454a53';
const EASE_OUT = EASINGS.easeOut;
const EASE_INOUT = EASINGS.easeInOut;

// =============================================================================
// CUES — straight from beats.json `timeline` (seconds * 30fps)
// =============================================================================
const END = 1230; // 41s @ 30fps
const SETUP_START = 132;
const REWIND = [SETUP_START, 160] as const;
const LIGHT = { img: 165, script: 210, ad: 258 } as const;
const PANEL1_IN = [300, 345] as const;
const PANEL1_MATCH = 438; // matchFoundAt
const PANEL1_OUT = [470, 500] as const;
const CUT = [515, 525] as const; // connectorCutAt
const PANEL2_IN = [780, 821] as const; // creditsAt
const CHIP_MORPH = [965, 985] as const; // blockerChipsAt
const PANEL2_OUT = [1060, 1089] as const; // loopStart

// =============================================================================
// SETTLE HELPER — every animated value in this shot is "already resolved" before
// SETUP_START (the hook's frame-0 payoff), rewinds to a baseline during REWIND,
// then builds back up on its own cue. Keeps frame 0 == the final/loop frame for
// free, without hand-syncing two separate states.
// =============================================================================
const settle = (frame: number, buildStart: number, buildEnd: number, finalValue: number, cutWindow?: readonly [number, number]) => {
  if (frame < REWIND[0]) return finalValue;
  if (frame < REWIND[1]) return finalValue * (1 - prog(frame, REWIND[0], REWIND[1]));
  let v = prog(frame, buildStart, buildEnd);
  if (cutWindow) v *= 1 - prog(frame, cutWindow[0], cutWindow[1]);
  return v;
};

const rackLit = (frame: number, kind: 'img' | 'script' | 'ad') => {
  if (kind === 'ad') return settle(frame, LIGHT.ad + 25, LIGHT.ad + 40, 0, CUT);
  const onAt = LIGHT[kind] + 25;
  return settle(frame, onAt, onAt + 15, 1);
};
const adCutProgress = (frame: number) => {
  if (frame < REWIND[0]) return 1;
  if (frame < REWIND[1]) return 1 - prog(frame, REWIND[0], REWIND[1]);
  if (frame < CUT[0]) return 0;
  return prog(frame, CUT[0], CUT[1]);
};

const RACK_COLOR: Record<'img' | 'script' | 'ad', string> = { img: INDIGO, script: VIOLET, ad: WARN };
const litColor = (frame: number, kind: 'img' | 'script' | 'ad') => chroma.mix(DIM, RACK_COLOR[kind], rackLit(frame, kind)).hex();

// =============================================================================
// GEOMETRY — one persistent canvas: rack row (background) -> dashed connectors
// -> the browser page (opaque, sits over the connectors' midsection = "behind
// the page") -> the laptop glyph (foreground). Diagonal hops replace network.tsx's
// single-axis PacketDot/DashedConnector since the 3 racks sit at different x's.
// =============================================================================
const RACK_Y = 380;
const RACK_X = { img: 260, script: 540, ad: 820 } as const;
const RACK_BOTTOM_Y = RACK_Y + 85;
const BROWSER_BOX = { x: 70, y: 560, w: 940, h: 740 };
const UI_SCALE = 1.3;
const CONTENT_H = BROWSER_BOX.h - (46 + 56) * UI_SCALE;
const LAPTOP_X = 540;
const LAPTOP_Y = 1400;
const LAPTOP_TOP_Y = LAPTOP_Y - 90;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// panel visibility envelopes (trapezoid: rises on IN, holds at 1, falls on OUT)
const envelope = (frame: number, inW: readonly [number, number], outW: readonly [number, number]) =>
  Math.max(0, prog(frame, inW[0], inW[1]) - prog(frame, outW[0], outW[1]));

// =============================================================================
// RACK + CONNECTOR DIAGRAM
// =============================================================================
const RackRow: React.FC<{ frame: number; opacity: number }> = ({ frame, opacity }) => {
  const labels: Record<'img' | 'script' | 'ad', string> = { img: 'IMAGES', script: 'SCRIPTS', ad: 'ADS' };
  return (
    <>
      {(['img', 'script', 'ad'] as const).map((kind) => (
        <div
          key={kind}
          style={{
            position: 'absolute',
            left: RACK_X[kind],
            top: RACK_Y,
            transform: 'translate(-50%, -50%)',
            opacity,
            textAlign: 'center',
          }}
        >
          <RackGlyph size={140} color={litColor(frame, kind)} />
          <div
            style={{
              marginTop: 10,
              fontFamily: FONT_MONO,
              fontWeight: 600,
              fontSize: 24,
              letterSpacing: 2,
              color: litColor(frame, kind),
            }}
          >
            {labels[kind]}
          </div>
        </div>
      ))}
    </>
  );
};

type Hop = { from: number; to: number; x1: number; y1: number; x2: number; y2: number; label: string; color: string };
const hopsFor = (kind: 'img' | 'script' | 'ad'): Hop[] => {
  const base = LIGHT[kind];
  const rackPt = { x: RACK_X[kind], y: RACK_BOTTOM_Y };
  const laptopPt = { x: LAPTOP_X, y: LAPTOP_TOP_Y };
  const color = RACK_COLOR[kind];
  return [
    { from: base, to: base + 15, x1: laptopPt.x, y1: laptopPt.y, x2: rackPt.x, y2: rackPt.y, label: 'GET', color },
    { from: base + 15, to: base + 30, x1: rackPt.x, y1: rackPt.y, x2: laptopPt.x, y2: laptopPt.y, label: '200', color },
  ];
};
const ALL_HOPS = [...hopsFor('img'), ...hopsFor('script'), ...hopsFor('ad')];

const DiagPacket: React.FC<{ hop: Hop; frame: number; opacity: number }> = ({ hop, frame, opacity }) => {
  const t = prog(frame, hop.from, hop.to);
  if (t <= 0 || t >= 1) return null;
  const x = lerp(hop.x1, hop.x2, t);
  const y = lerp(hop.y1, hop.y2, t);
  const pulse = 1 + 0.18 * Math.sin(t * Math.PI);
  return (
    <div style={{ position: 'absolute', left: x, top: y, transform: `translate(-50%, -50%) scale(${pulse})`, opacity }}>
      <div style={{ width: 20, height: 20, borderRadius: '50%', background: hop.color, boxShadow: `0 0 24px ${hop.color}` }} />
      <div
        style={{
          position: 'absolute', left: '50%', top: -34, transform: 'translateX(-50%)', whiteSpace: 'nowrap',
          fontFamily: FONT_MONO, fontWeight: 700, fontSize: 19, color: hop.color,
          background: 'rgba(10,10,14,0.78)', padding: '4px 10px', borderRadius: 7,
        }}
      >
        {hop.label}
      </div>
    </div>
  );
};

// Full dashed line laptop<->rack: drawn for img/script always, and for the ad
// route only while it hasn't been cut yet (baseline flashback in SETUP).
const FullConnector: React.FC<{ kind: 'img' | 'script' | 'ad'; frame: number; diagramOpacity: number }> = ({ kind, frame, diagramOpacity }) => {
  const lit = rackLit(frame, kind);
  const cutFade = kind === 'ad' ? 1 - adCutProgress(frame) : 1;
  const o = (0.22 + 0.55 * lit) * diagramOpacity * cutFade;
  if (o <= 0.01) return null;
  const color = litColor(frame, kind);
  return (
    <svg style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }} width={1080} height={1920}>
      <line
        x1={RACK_X[kind]} y1={RACK_BOTTOM_Y} x2={LAPTOP_X} y2={LAPTOP_TOP_Y}
        stroke={color} strokeWidth={4} strokeDasharray="3 16" strokeLinecap="round" opacity={o}
      />
    </svg>
  );
};

// The ad route's broken stub + red X — rendered in FRONT of the page (with the
// laptop), so the cut reads as happening at the laptop's own edge, not behind it.
const CutStub: React.FC<{ frame: number; diagramOpacity: number }> = ({ frame, diagramOpacity }) => {
  const p = adCutProgress(frame);
  if (p <= 0.01) return null;
  const stubFrac = 0.16;
  const sx = lerp(LAPTOP_X, RACK_X.ad, stubFrac);
  const sy = lerp(LAPTOP_TOP_Y, RACK_BOTTOM_Y, stubFrac);
  const o = p * diagramOpacity;
  return (
    <>
      <svg style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }} width={1080} height={1920}>
        <line x1={LAPTOP_X} y1={LAPTOP_TOP_Y} x2={sx} y2={sy} stroke={PINK} strokeWidth={4} strokeDasharray="3 12" strokeLinecap="round" opacity={o} />
      </svg>
      <div style={{ position: 'absolute', left: sx, top: sy, transform: `translate(-50%, -50%) scale(${0.72 + 0.28 * p})`, opacity: o }}>
        <svg width={56} height={56} viewBox="0 0 64 64">
          <line x1="14" y1="14" x2="50" y2="50" stroke={PINK} strokeWidth={9} strokeLinecap="round" />
          <line x1="50" y1="14" x2="14" y2="50" stroke={PINK} strokeWidth={9} strokeLinecap="round" />
        </svg>
      </div>
    </>
  );
};

// =============================================================================
// PAGE MOCK — a believable article inside WebBrowserFrame: hero image + text
// paint in as the img/script racks respond; the ad slot paints bright during the
// baseline flashback, then reverts to a blank dashed rectangle once cut.
// =============================================================================
const PageMock: React.FC<{ frame: number }> = ({ frame }) => {
  const imgPaint = settle(frame, LIGHT.img + 40, LIGHT.img + 55, 1);
  const textPaint = settle(frame, LIGHT.script + 40, LIGHT.script + 55, 1);
  const adPaint = settle(frame, LIGHT.ad + 40, LIGHT.ad + 55, 0, CUT);
  return (
    <div style={{ position: 'relative', width: BROWSER_BOX.w, height: CONTENT_H, background: '#fffef7', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', left: 30, top: 18, display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ width: 26, height: 26, borderRadius: 6, background: INDIGO }} />
        <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 25, color: '#1a1a2e', letterSpacing: 0.5 }}>THE MORNING FEED</div>
      </div>

      {/* hero image */}
      <div style={{ position: 'absolute', left: 30, top: 66, width: 880, height: 196, borderRadius: 14, overflow: 'hidden', background: '#e3e6ec' }}>
        <div
          style={{
            position: 'absolute', inset: 0, opacity: imgPaint,
            background: `linear-gradient(160deg, ${INDIGO}, ${VIOLET} 55%, ${TEAL})`,
          }}
        >
          <svg width="100%" height="100%" viewBox="0 0 880 196" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0 }}>
            <circle cx="140" cy="60" r="30" fill="rgba(255,255,255,0.85)" />
            <polygon points="0,196 220,90 360,160 520,70 880,196" fill="rgba(255,255,255,0.18)" />
          </svg>
        </div>
      </div>

      {/* headline + body */}
      <div style={{ position: 'absolute', left: 30, top: 288, width: 880 }}>
        {[{ w: 620, h: 32 }, { w: 860, h: 20 }, { w: 780, h: 20 }, { w: 700, h: 20 }].map((l, i) => (
          <div key={i} style={{ position: 'relative', width: l.w, height: l.h, marginBottom: 14, borderRadius: 5, background: '#d7dae1' }}>
            <div
              style={{
                position: 'absolute', inset: 0, borderRadius: 5, opacity: textPaint,
                background: i === 0 ? '#1a1a2e' : '#6b6b7b',
              }}
            />
          </div>
        ))}
      </div>

      {/* ad slot */}
      <div style={{ position: 'absolute', left: 30, top: 500, width: 880, height: 100, borderRadius: 12 }}>
        <div
          style={{
            position: 'absolute', inset: 0, borderRadius: 12, opacity: 1 - adPaint,
            border: `2px dashed ${COLORS.muted}`, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <span style={{ fontFamily: FONT_MONO, fontSize: 20, letterSpacing: 2, color: COLORS.muted }}>AD SLOT · EMPTY</span>
        </div>
        <div
          style={{
            position: 'absolute', inset: 0, borderRadius: 12, opacity: adPaint,
            background: `linear-gradient(100deg, ${WARN}, ${PINK})`, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <span style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 30, color: '#1a1a2e', letterSpacing: 2 }}>AD</span>
        </div>
      </div>
    </div>
  );
};

// =============================================================================
// FILTER-LIST PANEL — two views of the same document: a mid-scroll "rows" view
// (REVEAL 1) where the request scans the list and lands on a match, and a
// pulled-back "credits" view (TWIST) with the EasyList header + maintainer /
// extension chips. No AI/brain iconography anywhere near either view.
// =============================================================================
const ROWS = ['||googlesyndication.com^', '/ads/*', '||adservice.google.com^', '||doubleclick.net^', '||amazon-adsystem.com^', '||taboola.com^'];
const MATCH_IDX = 3;

const FilterRowsView: React.FC<{ frame: number; visible: number }> = ({ frame, visible }) => {
  if (visible <= 0.01) return null;
  const scanP = prog(frame, PANEL1_IN[1], PANEL1_MATCH - 20);
  const locked = frame >= PANEL1_MATCH - 20;
  const activeIdx = locked ? MATCH_IDX : Math.min(ROWS.length - 1, Math.floor(scanP * ROWS.length));
  const scale = lerp(0.84, 1, EASE_OUT(visible));
  return (
    <div
      style={{
        position: 'absolute', left: 60, top: 430, width: 960, height: 900,
        transform: `scale(${scale})`, transformOrigin: 'top center', opacity: visible,
        background: '#fffef7', borderRadius: 22, boxShadow: '0 24px 90px rgba(0,0,0,0.5)', border: `1px solid ${COLORS.line}`,
        padding: '34px 40px',
      }}
    >
      <div style={{ fontFamily: FONT_BODY, fontWeight: 600, fontSize: 24, letterSpacing: 3, color: COLORS.muted, textTransform: 'uppercase' }}>
        FILTER LIST
      </div>
      <div style={{ fontFamily: FONT_MONO, fontWeight: 600, fontSize: 28, color: INDIGO, marginTop: 10 }}>
        GET doubleclick.net/pagead/ads.js
      </div>
      <div style={{ marginTop: 28 }}>
        {ROWS.map((row, i) => {
          const isMatch = locked && i === MATCH_IDX;
          const isScanning = !locked && i === activeIdx;
          const bg = isMatch ? `${PINK}26` : isScanning ? `${INDIGO}1f` : 'transparent';
          const color = isMatch ? PINK : isScanning ? INDIGO : COLORS.ink;
          return (
            <div
              key={row}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '16px 18px', borderRadius: 12, background: bg, marginBottom: 6,
              }}
            >
              <span style={{ fontFamily: FONT_MONO, fontWeight: 600, fontSize: 30, color }}>{row}</span>
              {isMatch ? (
                <span style={{ fontFamily: FONT_MONO, fontWeight: 700, fontSize: 24, color: PINK, letterSpacing: 2 }}>✕ MATCH</span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
};

type Chip = { label: string };
const MAINTAINERS: Chip[] = [{ label: 'Fanboy' }, { label: 'MonztA' }, { label: 'Khrin' }, { label: 'Yuki2718' }];
const BLOCKERS: Chip[] = [{ label: 'uBlock Origin' }, { label: 'Adblock Plus' }, { label: 'Every major blocker' }];

const ChipRow: React.FC<{ chips: Chip[]; frame: number; baseAt: number; opacity: number; color: string }> = ({ chips, frame, baseAt, opacity, color }) => {
  if (opacity <= 0.01) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, justifyContent: 'center', marginTop: 40 }}>
      {chips.map((c, i) => {
        const p = EASE_OUT(prog(frame, baseAt + i * 5, baseAt + i * 5 + 12));
        return (
          <div
            key={c.label}
            style={{
              opacity: opacity * p,
              transform: `translateY(${(1 - p) * 14}px) scale(${0.92 + 0.08 * p})`,
              fontFamily: FONT_BODY, fontWeight: 600, fontSize: 26, color: '#fff',
              background: `${color}33`, border: `2px solid ${color}`, borderRadius: 999,
              padding: '12px 26px',
            }}
          >
            {c.label}
          </div>
        );
      })}
    </div>
  );
};

const FilterCreditsView: React.FC<{ frame: number; visible: number }> = ({ frame, visible }) => {
  if (visible <= 0.01) return null;
  const chips4Opacity = 1 - prog(frame, CHIP_MORPH[0], CHIP_MORPH[1]);
  const chips3Opacity = prog(frame, CHIP_MORPH[0], CHIP_MORPH[1]);
  const scale = lerp(0.88, 1, EASE_OUT(visible));
  return (
    <div
      style={{
        position: 'absolute', left: 120, top: 560, width: 840, minHeight: 640,
        transform: `scale(${scale})`, transformOrigin: 'top center', opacity: visible,
        background: '#fffef7', borderRadius: 22, boxShadow: '0 24px 90px rgba(0,0,0,0.5)', border: `1px solid ${COLORS.line}`,
        padding: '46px 44px', textAlign: 'center',
      }}
    >
      <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 60, color: '#1a1a2e', letterSpacing: 1 }}>EasyList</div>
      <div style={{ fontFamily: FONT_BODY, fontWeight: 500, fontSize: 26, color: COLORS.muted, marginTop: 10 }}>
        the default filter subscription
      </div>
      <div style={{ position: 'relative', height: 220 }}>
        <div style={{ position: 'absolute', inset: 0, opacity: chips4Opacity }}>
          <ChipRow chips={MAINTAINERS} frame={frame} baseAt={PANEL2_IN[1]} opacity={chips4Opacity} color={VIOLET} />
        </div>
        <div style={{ position: 'absolute', inset: 0, opacity: chips3Opacity }}>
          <ChipRow chips={BLOCKERS} frame={frame} baseAt={CHIP_MORPH[1]} opacity={chips3Opacity} color={TEAL} />
        </div>
      </div>
    </div>
  );
};

// =============================================================================
// LIVING BACKDROP — slow drifting brand-colour glows + dot grid, periodic over
// the whole loop so frame 0 == last frame.
// =============================================================================
const LivingBackdrop: React.FC = () => {
  const frame = useCurrentFrame();
  const a = (2 * Math.PI * frame) / END;
  const blob = (cx: number, cy: number, r: number, color: string, k: number, ph: number, amp: number) => (
    <div style={{ position: 'absolute', left: cx + Math.sin(a * k + ph) * amp - r, top: cy + Math.cos(a * k + ph) * amp - r, width: r * 2, height: r * 2, borderRadius: '50%', background: `radial-gradient(circle, ${color} 0%, transparent 68%)` }} />
  );
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {blob(220, 420, 520, 'rgba(99,102,241,0.18)', 2, 0, 90)}
      {blob(880, 1000, 560, 'rgba(155,124,196,0.14)', 3, 2, 80)}
      {blob(300, 1560, 520, 'rgba(77,184,168,0.14)', 2, 4, 100)}
      <AbsoluteFill style={{ backgroundImage: 'radial-gradient(rgba(255,255,255,0.06) 1.5px, transparent 1.6px)', backgroundSize: '54px 54px', opacity: 0.6 }} />
    </AbsoluteFill>
  );
};

// =============================================================================
// MAIN COMPONENT
// =============================================================================
const Short17AdBlocker: React.FC = () => {
  const f = useCurrentFrame();

  const punch = f < 30 ? 1.05 - 0.05 * EASE_INOUT(prog(f, 0, 30)) : f > END - 60 ? 1 + 0.05 * EASE_INOUT(prog(f, END - 60, END)) : 1;

  const panel1Vis = envelope(f, PANEL1_IN, PANEL1_OUT);
  const panel2Vis = envelope(f, PANEL2_IN, PANEL2_OUT);
  const diagramOpacity = Math.max(0, 1 - panel1Vis - panel2Vis * 0.55);

  return (
    <AbsoluteFill style={{ background: '#101418' }}>
      <ShortsBackdrop base="#101418" glow="#1b232c" />
      <LivingBackdrop />

      <AbsoluteFill style={{ transform: `scale(${punch})` }}>
        <Kicker text="IT NEVER LEFT" color={PINK} at={-14} until={SETUP_START} />
        <Kicker text="LOADING A PAGE" color={INDIGO} at={SETUP_START} until={PANEL1_IN[0]} />
        <Kicker text="CHECKING THE LIST" color={VIOLET} at={PANEL1_IN[0]} until={PANEL1_OUT[1]} />
        <Kicker text="BLOCKED BEFORE IT SENDS" color={WARN} at={PANEL1_OUT[1]} until={PANEL2_IN[0]} />
        <Kicker text="NOT AI. A TEXT FILE." color={VIOLET} at={PANEL2_IN[0]} until={CHIP_MORPH[1]} />
        <Kicker text="ONE LIST. EVERY BLOCKER." color={TEAL} at={CHIP_MORPH[1]} until={END} />

        <RackRow frame={f} opacity={diagramOpacity} />
        <FullConnector kind="img" frame={f} diagramOpacity={diagramOpacity} />
        <FullConnector kind="script" frame={f} diagramOpacity={diagramOpacity} />
        <FullConnector kind="ad" frame={f} diagramOpacity={diagramOpacity} />
        {ALL_HOPS.map((hop, i) => (
          <DiagPacket key={i} hop={hop} frame={f} opacity={diagramOpacity} />
        ))}

        <div style={{ opacity: diagramOpacity }}>
          <WebBrowserFrame url="themorningfeed.com" tabTitle="The Morning Feed" box={BROWSER_BOX} appearAt={-20} uiScale={UI_SCALE}>
            <PageMock frame={f} />
          </WebBrowserFrame>
        </div>

        <CutStub frame={f} diagramOpacity={diagramOpacity} />

        <div style={{ position: 'absolute', left: LAPTOP_X, top: LAPTOP_Y, transform: 'translate(-50%, -50%)', opacity: diagramOpacity }}>
          <LaptopGlyph size={260} tint="#8fb7c9" />
        </div>

        <FilterRowsView frame={f} visible={panel1Vis} />
        <FilterCreditsView frame={f} visible={panel2Vis} />
      </AbsoluteFill>

      <Captions lines={VO} y={1500} accent={WARN} />
      <ProgressBar color={WARN} />
    </AbsoluteFill>
  );
};

export default Short17AdBlocker;
