import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { COLORS } from '../../brand';
import { FONT_MONO } from '../../fonts';
import { Captions, Kicker, ProgressBar, ShortsBackdrop, prog } from '../../lib/shorts';
import { PhoneShell, ScrollTrack, ChatBubble, WindowFrame, TokenStrip, MiniChatPanel, resendHighlight } from '../../lib/chatui';
import { VO } from './vo.gen';

// =============================================================================
// COMPOSITION CONFIG
// =============================================================================
export const compositionConfig = {
  id: 'Short18ContextWindow',
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

// =============================================================================
// CUES — straight from beats.json `timeline` (seconds * 30fps). One persistent
// canvas, no <Sequence> scenes — every cue is a GLOBAL frame.
// =============================================================================
const END = 1230; // 41s
const SETUP_START = 143; // 4.77s
const WINDOW_CHIP_AT = 352; // 11.74s — "a context window, measured in tokens"
const TOKEN_REVEAL_AT = 494; // 16.48s — push-in begins landing
const FIFO_TICKS = [525, 570, 618, 663]; // 17.5 / 19.0 / 20.6 / 22.1s
const ROT_DIM_AT = 715; // 23.82s
const TWIST_AT = 902; // 30.05s
const LOOP_START = 1100; // 36.65s

const RESENT_PULSES = [SETUP_START + 22, SETUP_START + 92, SETUP_START + 157];
const RESENT_LABEL_IN: [number, number] = [SETUP_START + 12, SETUP_START + 27];
const RESENT_LABEL_OUT: [number, number] = [WINDOW_CHIP_AT - 17, WINDOW_CHIP_AT];
const CHIP_IN: [number, number] = [WINDOW_CHIP_AT, WINDOW_CHIP_AT + 15];
const CHIP_OUT: [number, number] = [LOOP_START - 21, LOOP_START - 1];
const PUSH_IN: [number, number] = [TOKEN_REVEAL_AT - 34, TOKEN_REVEAL_AT];
const PUSH_OUT: [number, number] = [TWIST_AT - 42, TWIST_AT - 2];
const WORDS_CHIP_IN: [number, number] = [TOKEN_REVEAL_AT + 46, TOKEN_REVEAL_AT + 61];
const RELIABILITY_CHIP_IN: [number, number] = [ROT_DIM_AT + 19, ROT_DIM_AT + 34];
const SPLIT_IN: [number, number] = [TWIST_AT, TWIST_AT + 24];
const SPLIT_OUT: [number, number] = [LOOP_START - 29, LOOP_START - 1];

// rise on the first window, hold at 1, fall on the second — never negative
const envelope = (frame: number, inW: [number, number], outW: [number, number]) =>
  Math.max(0, prog(frame, inW[0], inW[1]) - prog(frame, outW[0], outW[1]));

// =============================================================================
// GEOMETRY — one phone mockup (foreground) + a token-strip layer beneath it that
// the "camera" (a translate+scale wrapper) pushes into for REVEAL 1/2.
// =============================================================================
const PHONE = { x: 110, y: 260, w: 860, h: 1000 };
const HEADER_H = 130;
// bubble stack, LOCAL to the phone's clipped content div (origin = page (110, 330))
const BUBBLE_H = 112;
const STEP = 126;
const CONTENT_BOTTOM = 800; // local
const FRAME = { x: 20, y: 36, w: 820, h: 786 }; // local, bounds the 6 newest bubbles

const WINDOW_BUBBLES: { text: string; from: 'user' | 'ai' }[] = [
  { text: 'Can you help me debug this?', from: 'user' },
  { text: 'Sure — paste the error.', from: 'ai' },
  { text: 'TypeError: undefined is not a function', from: 'user' },
  { text: 'Check line 42 — likely a null reference.', from: 'ai' },
  { text: 'That fixed it, thanks!', from: 'user' },
  { text: 'Anytime — want me to review the rest?', from: 'ai' },
];

const WHAT_YOU_SEE = [
  { text: 'Hey, quick question', from: 'user' as const, faded: true },
  { text: 'Sure, go ahead!', from: 'ai' as const, faded: true },
  { text: "my dog's name is Max", from: 'user' as const },
  ...WINDOW_BUBBLES,
];
const WHAT_IT_SEES = WINDOW_BUBBLES;

// =============================================================================
// LABEL PILL — the slot centered on the window frame's top border. Two cues
// (RESENT EVERY TURN, then the stat chip) swap through it, never both at once.
// =============================================================================
const Pill: React.FC<{ text: string; color: string; opacity: number; x: number; y: number; w: number }> = ({
  text,
  color,
  opacity,
  x,
  y,
  w,
}) => {
  if (opacity <= 0.01) return null;
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: w,
        display: 'flex',
        justifyContent: 'center',
        transform: 'translateY(-50%)',
        opacity,
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
          background: color,
          borderRadius: 999,
          padding: '9px 22px',
          whiteSpace: 'nowrap',
          boxShadow: `0 8px 28px ${color}55`,
        }}
      >
        {text}
      </div>
    </div>
  );
};

const Chip: React.FC<{ text: string; color: string; opacity: number; x: number; y: number }> = ({ text, color, opacity, x, y }) => {
  if (opacity <= 0.01) return null;
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        opacity,
        fontFamily: FONT_MONO,
        fontWeight: 700,
        fontSize: 24,
        letterSpacing: 1.5,
        color,
        border: `2px solid ${color}88`,
        borderRadius: 999,
        padding: '10px 24px',
        background: 'rgba(10,12,16,0.82)',
        whiteSpace: 'nowrap',
      }}
    >
      {text}
    </div>
  );
};

// =============================================================================
// LIVING BACKDROP — slow drifting brand-colour glows, periodic over the whole
// loop so frame 0 == last frame.
// =============================================================================
const LivingBackdrop: React.FC = () => {
  const frame = useCurrentFrame();
  const a = (2 * Math.PI * frame) / END;
  const blob = (cx: number, cy: number, r: number, color: string, k: number, ph: number, amp: number) => (
    <div
      style={{
        position: 'absolute',
        left: cx + Math.sin(a * k + ph) * amp - r,
        top: cy + Math.cos(a * k + ph) * amp - r,
        width: r * 2,
        height: r * 2,
        borderRadius: '50%',
        background: `radial-gradient(circle, ${color} 0%, transparent 68%)`,
      }}
    />
  );
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {blob(220, 420, 520, 'rgba(99,102,241,0.16)', 2, 0, 90)}
      {blob(880, 1000, 560, 'rgba(155,124,196,0.13)', 3, 2, 80)}
      {blob(300, 1560, 520, 'rgba(77,184,168,0.13)', 2, 4, 100)}
      <AbsoluteFill
        style={{
          backgroundImage: 'radial-gradient(rgba(255,255,255,0.05) 1.5px, transparent 1.6px)',
          backgroundSize: '54px 54px',
          opacity: 0.6,
        }}
      />
    </AbsoluteFill>
  );
};

// =============================================================================
// MAIN COMPONENT
// =============================================================================
const Short18ContextWindow: React.FC = () => {
  const f = useCurrentFrame();

  // push-in (REVEAL 1/2) and twist-split (TWIST) are mutually exclusive windows
  const pushP = Math.max(0, prog(f, PUSH_IN[0], PUSH_IN[1]) - prog(f, PUSH_OUT[0], PUSH_OUT[1]));
  const twistP = Math.max(0, prog(f, SPLIT_IN[0], SPLIT_IN[1]) - prog(f, SPLIT_OUT[0], SPLIT_OUT[1]));

  const phoneOpacity = Math.max(0.08, 1 - 0.88 * pushP - 0.88 * twistP);
  const phoneScale = 1 - 0.16 * pushP - 0.1 * twistP;
  const phoneTY = -50 * pushP - 20 * twistP;

  const resentLabelOp = envelope(f, RESENT_LABEL_IN, RESENT_LABEL_OUT);
  const chipOp = envelope(f, CHIP_IN, CHIP_OUT);
  const wordsChipOp = pushP * envelope(f, WORDS_CHIP_IN, PUSH_OUT);
  const reliabilityChipOp = pushP * envelope(f, RELIABILITY_CHIP_IN, PUSH_OUT);

  return (
    <AbsoluteFill style={{ background: '#0d0f14' }}>
      <ShortsBackdrop base="#0d0f14" glow="#1a1f2b" />
      <LivingBackdrop />

      <Kicker text="A CHAT, NOT A MEMORY" color={INDIGO} at={-20} until={SETUP_START} />
      <Kicker text="RESENT EVERY TURN" color={WARN} at={SETUP_START} until={WINDOW_CHIP_AT} />
      <Kicker text="A HARD LIMIT, IN TOKENS" color={INDIGO} at={WINDOW_CHIP_AT} until={TOKEN_REVEAL_AT} />
      <Kicker text="OLDEST OUT, AUTOMATICALLY" color={TEAL} at={TOKEN_REVEAL_AT} until={ROT_DIM_AT} />
      <Kicker text="RELIABILITY FADES BEFORE FULL" color={PINK} at={ROT_DIM_AT} until={TWIST_AT} />
      <Kicker text="WHAT YOU SEE VS WHAT IT SEES" color={VIOLET} at={TWIST_AT} until={LOOP_START} />
      <Kicker text="THE WINDOW NEVER GROWS" color={TEAL} at={LOOP_START} until={END} />

      {/* ---- phone group: chat thread + glowing context-window frame ---- */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          opacity: phoneOpacity,
          transform: `translateY(${phoneTY}px) scale(${phoneScale})`,
        }}
      >
        <PhoneShell x={PHONE.x} y={PHONE.y} w={PHONE.w} h={PHONE.h} headerH={HEADER_H} title="Messages">
          <ScrollTrack x={836} y={10} h={840} thumbFrac={0.88} />
          {/* the one bubble scrolled above the window — faded, mostly cropped by the header */}
          <ChatBubble text="my dog's name is Max" from="user" x={280} y={-72} w={540} h={BUBBLE_H} opacity={0.42} />
          {WINDOW_BUBBLES.map((b, rank) => {
            const posIndex = WINDOW_BUBBLES.length - 1 - rank; // 0 = newest/bottom
            const bottom = CONTENT_BOTTOM - posIndex * STEP;
            const top = bottom - BUBBLE_H;
            const x = b.from === 'user' ? 280 : 40;
            return (
              <ChatBubble
                key={rank}
                text={b.text}
                from={b.from}
                x={x}
                y={top}
                w={540}
                h={BUBBLE_H}
                highlight={resendHighlight(f, rank, RESENT_PULSES)}
              />
            );
          })}
          <WindowFrame x={FRAME.x} y={FRAME.y} w={FRAME.w} h={FRAME.h} color={INDIGO} />
          <Pill text="RESENT EVERY TURN" color={WARN} opacity={resentLabelOp} x={FRAME.x} y={FRAME.y} w={FRAME.w} />
          <Pill text="CONTEXT WINDOW · FIXED SIZE" color={INDIGO} opacity={chipOp} x={FRAME.x} y={FRAME.y} w={FRAME.w} />
        </PhoneShell>
      </div>

      {/* ---- token-strip group: the camera "pushes into" this on REVEAL 1/2 ---- */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 1300,
          width: 1080,
          height: 300,
          opacity: pushP,
          transform: `translateY(${-520 * pushP}px) scale(${1 + 0.12 * pushP})`,
          transformOrigin: '50% 50%',
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: 20,
            top: -26,
            width: 1040,
            height: 248,
            borderRadius: 26,
            background: 'rgba(10,12,18,0.88)',
            border: `1px solid ${INDIGO}33`,
            boxShadow: '0 24px 70px rgba(0,0,0,0.5)',
          }}
        />
        <div style={{ position: 'absolute', left: 0, top: 0, width: 1080, textAlign: 'center' }}>
          <span style={{ fontFamily: FONT_MONO, fontWeight: 700, fontSize: 38, letterSpacing: 1, color: INDIGO }}>
            128,000 / 128,000 TOKENS
          </span>
        </div>
        <Chip text="≈96,000 WORDS" color={TEAL} opacity={wordsChipOp} x={70} y={44} />
        <TokenStrip x={70} y={94} w={940} cellCount={56} tickFrames={FIFO_TICKS} dimAt={ROT_DIM_AT} dimBandCells={12} color={INDIGO} />
        {reliabilityChipOp > 0.01 ? (
          <div style={{ position: 'absolute', left: 0, top: 158, width: 1080, display: 'flex', justifyContent: 'center', opacity: reliabilityChipOp }}>
            <div
              style={{
                fontFamily: FONT_MONO,
                fontWeight: 700,
                fontSize: 22,
                letterSpacing: 1,
                color: PINK,
                border: `2px solid ${PINK}88`,
                borderRadius: 999,
                padding: '10px 24px',
                background: 'rgba(10,12,16,0.82)',
                whiteSpace: 'nowrap',
              }}
            >
              RELIABILITY DROPS PAST ~2,500 WORDS
            </div>
          </div>
        ) : null}
      </div>

      {/* ---- twist: what you see vs what it sees ---- */}
      <div style={{ position: 'absolute', inset: 0, opacity: twistP, pointerEvents: 'none' }}>
        <MiniChatPanel x={50} y={420} w={480} h={760} title="WHAT YOU SEE" color={TEAL} rows={WHAT_YOU_SEE} />
        <MiniChatPanel x={550} y={420} w={480} h={760} title="WHAT IT SEES" color={INDIGO} rows={WHAT_IT_SEES} />
      </div>

      <Captions lines={VO} y={1500} accent={WARN} />
      <ProgressBar color={INDIGO} />
    </AbsoluteFill>
  );
};

export default Short18ContextWindow;
