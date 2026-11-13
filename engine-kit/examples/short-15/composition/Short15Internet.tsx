import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { Captions, Kicker, ProgressBar, ShortsBackdrop, Stamp, StatChip, prog } from '../../lib/shorts';
import { EASINGS } from '../../brand';
import { FONT_BODY, FONT_DISPLAY, FONT_MONO } from '../../fonts';
import { WebBrowserFrame } from '../../lib/browser';
import { NetNode, DashedConnector, PacketDot, BounceCounter, Padlock, PaintReveal, DomNodes } from '../../lib/network';
import { VO } from './vo.gen';

// =============================================================================
// COMPOSITION CONFIG
// =============================================================================
export const compositionConfig = {
  id: 'Short15Internet',
  durationInSeconds: 42,
  fps: 30,
  width: 1080,
  height: 1920,
};

// =============================================================================
// STYLE CONSTANTS
// =============================================================================
const GOLD = '#f5d76e';
const INDIGO = '#6366F1';
const VIOLET = '#9b7cc4';
const TEAL = '#4db8a8';
const EASE_INOUT = EASINGS.easeInOut;

// =============================================================================
// CUES — straight from beats.json `network` (seconds * 30fps; all already round)
// =============================================================================
const SETUP_IN = 147, SHRINK_END = 225;
const DNS_ASK = 237, DNS_RESOLVER = 270, DNS_ROOT = 318, DNS_TLD = 372, DNS_AUTH = 426, DNS_IP = 474;
const REVEAL_IN = 495, TCP_SYN = 510, TCP_SYNACK = 552, TCP_ACK = 594;
const TLS = [708, 744, 780, 816, 852];
const PADLOCK_START = 594, PADLOCK_CLOSE = 858;
const STAMP_AT = 888;
const TWIST_IN = 921, REGROW_END = 990, DOM_BUILD = 990;
const PAINT_START = 1080, PAINT_END = 1140;
const LOOP_IN = 1158, END = 1260;

// =============================================================================
// GEOMETRY — one persistent canvas: the browser card IS the "client" node. It
// shrinks into a thin address bar for the DNS + handshake beats, then regrows
// around the arriving HTML response. Everything else is positioned in GLOBAL
// canvas coordinates — no Sequences, no local-frame math.
// =============================================================================
type Box = { x: number; y: number; w: number; h: number };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpBox = (A: Box, B: Box, t: number): Box => ({ x: lerp(A.x, B.x, t), y: lerp(A.y, B.y, t), w: lerp(A.w, B.w, t), h: lerp(A.h, B.h, t) });

const UI_SCALE = 1.3;
const HOOK_BOX: Box = { x: 60, y: 300, w: 960, h: 1080 };
const MINI_A: Box = { x: 340, y: 230, w: 400, h: 160 }; // address-bar-only, parked under the DNS chain
const MINI_B: Box = { x: 340, y: 420, w: 400, h: 160 }; // slides down to sit opposite the rack for the handshake
const PAGE_W = HOOK_BOX.w;
const PAGE_H = HOOK_BOX.h - (46 + 56) * UI_SCALE;

const boxAt = (f: number): Box => {
  if (f < SHRINK_END) return lerpBox(HOOK_BOX, MINI_A, EASE_INOUT(prog(f, SETUP_IN, SHRINK_END)));
  if (f < TWIST_IN) return lerpBox(MINI_A, MINI_B, EASE_INOUT(prog(f, DNS_IP, REVEAL_IN)));
  return lerpBox(MINI_B, HOOK_BOX, EASE_INOUT(prog(f, TWIST_IN, REGROW_END)));
};
// 1 = browser at full (hook/loop) size, 0 = shrunk to the mini address bar.
const fullness = (f: number): number => {
  if (f < SHRINK_END) return 1 - prog(f, SETUP_IN, SHRINK_END);
  if (f < TWIST_IN) return 0;
  return prog(f, TWIST_IN, REGROW_END);
};

const NODE_Y = { client: 310, resolver: 600, root: 820, tld: 1040, rackChain: 1260, clientR: 650, rackR: 1050 } as const;
const rackY = (f: number) => lerp(NODE_Y.rackChain, NODE_Y.rackR, EASE_INOUT(prog(f, DNS_IP, REVEAL_IN)));
const midNodesOpacity = (f: number) => prog(f, SETUP_IN, SHRINK_END) * (1 - prog(f, DNS_IP, REVEAL_IN));
const rackOpacity = (f: number) => prog(f, SETUP_IN, SHRINK_END) * (1 - prog(f, TWIST_IN, TWIST_IN + 39));

// =============================================================================
// PACKET HOPS — one component maps a cue list onto PacketDot; hides itself
// outside its own [from,to] window, so hops never need local-frame math.
// =============================================================================
type Hop = { from: number; to: number; y1: number; y2: number; label: string; color?: string };
const SETUP_HOPS: Hop[] = [
  { from: DNS_ASK, to: DNS_RESOLVER, y1: NODE_Y.client, y2: NODE_Y.resolver, label: 'DNS?' },
  { from: DNS_RESOLVER, to: DNS_ROOT, y1: NODE_Y.resolver, y2: NODE_Y.root, label: 'ROOT?' },
  { from: DNS_ROOT, to: DNS_TLD, y1: NODE_Y.root, y2: NODE_Y.tld, label: '.COM?' },
  { from: DNS_TLD, to: DNS_AUTH, y1: NODE_Y.tld, y2: NODE_Y.rackChain, label: 'AUTH?' },
  { from: DNS_AUTH, to: DNS_IP, y1: NODE_Y.rackChain, y2: NODE_Y.client, label: 'IP FOUND', color: TEAL },
];
const HANDSHAKE_HOPS: Hop[] = [
  { from: REVEAL_IN, to: TCP_SYN, y1: NODE_Y.clientR, y2: NODE_Y.rackR, label: 'SYN' },
  { from: TCP_SYN, to: TCP_SYNACK, y1: NODE_Y.rackR, y2: NODE_Y.clientR, label: 'SYN-ACK' },
  { from: TCP_SYNACK, to: TCP_ACK, y1: NODE_Y.clientR, y2: NODE_Y.rackR, label: 'ACK' },
  { from: TCP_ACK, to: TLS[0], y1: NODE_Y.rackR, y2: NODE_Y.clientR, label: 'TLS', color: VIOLET },
  { from: TLS[0], to: TLS[1], y1: NODE_Y.clientR, y2: NODE_Y.rackR, label: 'TLS', color: VIOLET },
  { from: TLS[1], to: TLS[2], y1: NODE_Y.rackR, y2: NODE_Y.clientR, label: 'TLS', color: VIOLET },
  { from: TLS[2], to: TLS[3], y1: NODE_Y.clientR, y2: NODE_Y.rackR, label: 'TLS', color: VIOLET },
  { from: TLS[3], to: TLS[4], y1: NODE_Y.rackR, y2: NODE_Y.clientR, label: 'TLS', color: VIOLET },
];
const TWIST_HOP: Hop = { from: TWIST_IN, to: TWIST_IN + 39, y1: NODE_Y.rackR, y2: NODE_Y.clientR, label: 'HTML', color: GOLD };

const Hops: React.FC<{ hops: Hop[] }> = ({ hops }) => {
  const f = useCurrentFrame();
  return (
    <>
      {hops.map((h, i) => (
        <PacketDot key={i} x={540} yFrom={h.y1} yTo={h.y2} t={prog(f, h.from, h.to)} label={h.label} color={h.color ?? GOLD} />
      ))}
    </>
  );
};

// =============================================================================
// COUNTER / PADLOCK / STAMP — the handshake's running tally.
// =============================================================================
const counterN = (f: number) => {
  if (f < TCP_SYN) return 0;
  if (f < TCP_SYNACK) return 1;
  if (f < TCP_ACK) return 2;
  if (f < TLS[0]) return 3;
  if (f < TLS[1]) return 4;
  if (f < TLS[2]) return 5;
  if (f < TLS[3]) return 6;
  if (f < TLS[4]) return 7;
  return 8;
};
const counterOpacity = (f: number) => prog(f, REVEAL_IN, TCP_SYN) * (1 - prog(f, STAMP_AT - 6, STAMP_AT + 4));
const padlockOpacity = (f: number) => prog(f, PADLOCK_START, PADLOCK_START + 16) * (1 - prog(f, TWIST_IN, TWIST_IN + 39));
const padlockProgress = (f: number) => prog(f, PADLOCK_START, PADLOCK_CLOSE - 8);

// =============================================================================
// PAGE CONTENT — a believable "dailybyte.com" article, wireframe + painted,
// sharing the same geometry so the paint sweep looks like it finishes the
// exact layout that was already sketched in.
// =============================================================================
const LINES = [
  { y: 0, w: 640, h: 30, heading: true },
  { y: 48, w: 888, h: 18 },
  { y: 76, w: 820, h: 18 },
  { y: 104, w: 760, h: 18 },
  { y: 132, w: 888, h: 18 },
  { y: 160, w: 700, h: 18 },
  { y: 188, w: 610, h: 18 },
] as const;

const PageWire: React.FC = () => (
  <div style={{ position: 'absolute', inset: 0, background: '#eef0f4' }}>
    <div style={{ position: 'absolute', left: 36, top: 26, width: 300, height: 26, borderRadius: 6, background: '#d7dae1' }} />
    <div style={{ position: 'absolute', left: 36, top: 68, right: 36, height: 300, borderRadius: 14, background: '#dcdfe6' }} />
    {LINES.map((l, i) => (
      <div key={i} style={{ position: 'absolute', left: 36, top: 400 + l.y, width: l.w, height: l.h, borderRadius: 6, background: '#d7dae1' }} />
    ))}
  </div>
);

const GRADIENT = `linear-gradient(120deg, ${INDIGO}, ${VIOLET}, ${TEAL})`;
const PageColor: React.FC = () => (
  <div style={{ position: 'absolute', inset: 0, background: '#fffef7' }}>
    <div style={{ position: 'absolute', left: 36, top: 22, display: 'flex', alignItems: 'center', gap: 14 }}>
      <div style={{ width: 30, height: 30, borderRadius: 8, background: INDIGO }} />
      <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 28, color: '#1a1a2e', letterSpacing: 0.5 }}>THE DAILY BYTE</div>
    </div>
    <div style={{ position: 'absolute', left: 36, top: 68, right: 36, height: 300, borderRadius: 14, background: GRADIENT, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', padding: 22 }}>
      <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 36, color: '#fff', lineHeight: 1.1 }}>Why Your Browser Waits</div>
      <div style={{ fontFamily: FONT_BODY, fontSize: 18, color: 'rgba(255,255,255,0.85)', marginTop: 6 }}>networking · 6 min read</div>
    </div>
    {LINES.slice(1).map((l, i) => (
      <div
        key={i}
        style={{
          position: 'absolute', left: 36, top: 400 + l.y, width: l.w, height: l.h - 6, borderRadius: 4,
          background: i % 3 === 0 ? '#1a1a2e' : '#6b6b7b', opacity: i % 3 === 0 ? 0.85 : 0.55,
        }}
      />
    ))}
  </div>
);

// =============================================================================
// DECOR — the hook's already-finished route ribbon, and the frame-budget HUD.
// =============================================================================
const RouteRibbon: React.FC<{ opacity: number }> = ({ opacity }) => {
  if (opacity <= 0.01) return null;
  return (
    <div style={{ position: 'absolute', left: '50%', top: 1392, transform: 'translateX(-50%)', width: 320, height: 14, opacity }}>
      <svg width={320} height={14} style={{ position: 'absolute' }}>
        <line x1={10} y1={7} x2={310} y2={7} stroke={INDIGO} strokeWidth={2} strokeDasharray="2 10" opacity={0.6} />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        {[INDIGO, VIOLET, TEAL].map((c, i) => (
          <div key={i} style={{ width: 12, height: 12, borderRadius: '50%', background: c, boxShadow: `0 0 10px ${c}` }} />
        ))}
      </div>
    </div>
  );
};

const ReadoutHUD: React.FC<{ opacity: number }> = ({ opacity }) => {
  if (opacity <= 0.01) return null;
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, top: 1310, display: 'flex', justifyContent: 'center', opacity }}>
      <div
        style={{
          textAlign: 'center',
          background: 'rgba(10,12,18,0.82)',
          border: `1px solid ${TEAL}55`,
          borderRadius: 16,
          padding: '12px 28px',
          boxShadow: '0 8px 28px rgba(0,0,0,0.35)',
        }}
      >
        <div style={{ fontFamily: FONT_MONO, fontWeight: 700, fontSize: 34, color: '#ffffff', letterSpacing: 2 }}>60 FPS</div>
        <div style={{ fontFamily: FONT_BODY, fontSize: 22, color: TEAL, marginTop: 4, letterSpacing: 1 }}>16.67 ms / frame</div>
      </div>
    </div>
  );
};

// Living backdrop: soft drifting brand-colour glows + faint dot grid, periodic over the
// whole 1260-frame loop so frame 0 == last frame.
const TOTAL = 1260;
const LivingBackdrop: React.FC = () => {
  const frame = useCurrentFrame();
  const a = (2 * Math.PI * frame) / TOTAL;
  const blob = (cx: number, cy: number, r: number, color: string, k: number, ph: number, amp: number) => (
    <div style={{ position: 'absolute', left: cx + Math.sin(a * k + ph) * amp - r, top: cy + Math.cos(a * k + ph) * amp - r, width: r * 2, height: r * 2, borderRadius: '50%', background: `radial-gradient(circle, ${color} 0%, transparent 68%)` }} />
  );
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {blob(220, 420, 520, 'rgba(99,102,241,0.2)', 2, 0, 90)}
      {blob(880, 1000, 560, 'rgba(155,124,196,0.15)', 3, 2, 80)}
      {blob(300, 1560, 520, 'rgba(77,184,168,0.15)', 2, 4, 100)}
      <AbsoluteFill style={{ backgroundImage: 'radial-gradient(rgba(255,255,255,0.06) 1.5px, transparent 1.6px)', backgroundSize: '54px 54px', opacity: 0.6 }} />
    </AbsoluteFill>
  );
};

// =============================================================================
// MAIN COMPONENT
// =============================================================================
const Short15Internet: React.FC = () => {
  const f = useCurrentFrame();

  // overall settle-in punch (hook) / grow-out punch (loop) — brand's gentle camera push.
  const punch = f < LOOP_IN ? 1.06 - 0.06 * EASE_INOUT(prog(f, 0, 30)) : 1.0 + 0.06 * EASE_INOUT(prog(f, LOOP_IN, END));

  const box = boxAt(f);
  const full = fullness(f);
  const paintProgress = f < SHRINK_END ? fullness(f) : f < PAINT_START ? 0 : prog(f, PAINT_START, PAINT_END);
  const domOpacity = prog(f, DOM_BUILD, DOM_BUILD + 16) * (1 - prog(f, PAINT_START - 6, PAINT_START + 14));
  const readoutOpacity = prog(f, PAINT_START + 10, PAINT_START + 30) * (1 - prog(f, LOOP_IN, LOOP_IN + 40));

  return (
    <AbsoluteFill style={{ background: '#0e141a' }}>
      <ShortsBackdrop base="#0e141a" glow="#16222e" />
      <LivingBackdrop />

      <AbsoluteFill style={{ transform: `scale(${punch})` }}>
        <Kicker text="THE REQUEST" color={INDIGO} at={-14} until={SETUP_IN} />
        <Kicker text="FINDING THE SERVER" color={VIOLET} at={SETUP_IN} until={REVEAL_IN} />
        <Kicker text="SHAKING HANDS" color={GOLD} at={REVEAL_IN} until={TWIST_IN} />
        <Kicker text="BUILDING THE PAGE" color={TEAL} at={TWIST_IN} until={LOOP_IN} />

        <WebBrowserFrame
          url="dailybyte.com"
          tabTitle="The Daily Byte"
          box={box}
          appearAt={-20}
          uiScale={UI_SCALE}
        >
          <PaintReveal progress={paintProgress} width={PAGE_W} height={PAGE_H} wire={<PageWire />} color={<PageColor />} />
          {domOpacity > 0.01 ? <DomNodes frame={f} at={DOM_BUILD} opacity={domOpacity} /> : null}
        </WebBrowserFrame>

        <div style={{ opacity: full }}>
          <StatChip label="PAGE LOAD" value="8 ROUND TRIPS" color={GOLD} x={640} y={250} w={360} at={-14} />
        </div>
        <RouteRibbon opacity={full} />

        {/* DNS chain */}
        <DashedConnector x={540} y1={NODE_Y.client} y2={NODE_Y.resolver} opacity={midNodesOpacity(f)} />
        <DashedConnector x={540} y1={NODE_Y.resolver} y2={NODE_Y.root} opacity={midNodesOpacity(f)} />
        <DashedConnector x={540} y1={NODE_Y.root} y2={NODE_Y.tld} opacity={midNodesOpacity(f)} />
        <DashedConnector x={540} y1={NODE_Y.tld} y2={rackY(f)} opacity={midNodesOpacity(f)} />
        <NetNode x={540} y={NODE_Y.resolver} kind="resolver" label="RESOLVER" opacity={midNodesOpacity(f)} />
        <NetNode x={540} y={NODE_Y.root} kind="root" label="ROOT" sub="13 ROOT SERVER GROUPS WORLDWIDE" opacity={midNodesOpacity(f)} />
        <NetNode x={540} y={NODE_Y.tld} kind="tld" label=".COM" sub="TLD SERVER" opacity={midNodesOpacity(f)} />
        <NetNode x={540} y={rackY(f)} kind="rack" label="DAILYBYTE.COM" sub="AUTHORITATIVE SERVER" opacity={rackOpacity(f)} />

        <Hops hops={SETUP_HOPS} />
        <Hops hops={HANDSHAKE_HOPS} />
        <Hops hops={[TWIST_HOP]} />

        <BounceCounter n={counterN(f)} x={540} y={760} opacity={counterOpacity(f)} />
        <div style={{ opacity: padlockOpacity(f) }}>
          <Padlock x={540} y={920} progress={padlockProgress(f)} closed={f >= PADLOCK_CLOSE} />
        </div>

        <Stamp text="8" at={STAMP_AT} until={TWIST_IN + 24} color={GOLD} x={540} y={1300} size={78} rotate={-6} />
        <Kicker text="REQUEST NOT EVEN SENT YET" color={VIOLET} y={1400} at={STAMP_AT} until={TWIST_IN} />

        <ReadoutHUD opacity={readoutOpacity} />
      </AbsoluteFill>

      <Captions lines={VO} y={1500} accent={GOLD} />
      <ProgressBar color={GOLD} />
    </AbsoluteFill>
  );
};

export default Short15Internet;
