import React from 'react';
import { AbsoluteFill, Audio, Easing, Sequence, getRemotionEnvironment, staticFile, useCurrentFrame } from 'remotion';
import { BigTitle, Captions, Kicker, ProgressBar, ShortsBackdrop, StatChip, prog } from '../../lib/shorts';
import { RangeBoard, binarySearchSteps, searchViewAt } from '../../lib/algo';
import { FONT_DISPLAY, FONT_MONO } from '../../fonts';
import { VO } from './vo.gen';

// =============================================================================
// COMPOSITION CONFIG
// =============================================================================
export const compositionConfig = {
  id: 'Short13BinSearch',
  durationInSeconds: 41,
  fps: 30,
  width: 1080,
  height: 1920,
};

// =============================================================================
// STYLE CONSTANTS
// =============================================================================
const GOLD = '#f5d76e';
const GREEN = '#4db8a8';
const PINK = '#e8879f';
const INDIGO = '#6366F1';
const EASE_INOUT = Easing.bezier(0.37, 0, 0.63, 1);

// =============================================================================
// PRE-GENERATED DATA — the REAL binary search (20 guesses, the worst case for 1M)
// =============================================================================
const N = 1_000_000;
const TARGET = 654_321;
const STEPS = binarySearchSteps(N, TARGET);
const durOf = (i: number) => (i < 2 ? 60 : i < 4 ? 42 : i < 10 ? 30 : 15);
const REVEAL_LOC = 318; // first guess: global 14.0s − scene mount 3.4s
const FINAL_VIEW = searchViewAt(STEPS, 1e9, durOf);
const GUESS_COUNT = STEPS.length; // 20 — feeds the title, never hardcoded

// =============================================================================
// SCENES
// =============================================================================
// Hook/loop: the finished game — the payoff is already on screen.
const HookScene: React.FC<{ mode: 'settle' | 'grow' }> = ({ mode }) => {
  const frame = useCurrentFrame();
  const scale = mode === 'settle' ? 1.06 - 0.06 * EASE_INOUT(prog(frame, 0, 28)) : 1.0 + 0.06 * EASE_INOUT(prog(frame, 0, 41));
  return (
    <AbsoluteFill style={{ transform: `scale(${scale})` }}>
      <BigTitle
        lines={[
          { text: '1,000,000 NUMBERS.', color: '#ffffff' },
          { text: `${GUESS_COUNT} GUESSES.`, color: GOLD },
        ]}
        subtitle="binary search"
        warm
        size={84}
      />
      <RangeBoard n={N} target={TARGET} view={FINAL_VIEW} y0={540} />
    </AbsoluteFill>
  );
};

// The persistent game: setup → slow way → halving → found → scale chips. One timeline.
const GameScene: React.FC = () => {
  const frame = useCurrentFrame();
  const fadeOut = 1 - prog(frame, 1082, 1098);
  const t = frame - REVEAL_LOC;
  const view = searchViewAt(STEPS, t, durOf);

  // slow way: linear sweep over the bar (global 8.2–11.6s → local 144–246)
  const scanRaw = prog(frame, 144, 246);
  const scanning = frame >= 144 && frame < 252;
  const scanP = scanRaw * scanRaw;
  const scanPill = scanRaw > 0.12 ? { text: 'UP TO 1,000,000 TRIES', color: PINK } : undefined;

  // twist: the board gives way to the scale chips
  const boardOp = 1 - prog(frame, 846, 866);
  const doublingIn = prog(frame, 972, 986);

  return (
    <AbsoluteFill style={{ opacity: fadeOut }}>
      <Kicker text="THE GAME" at={8} until={136} />
      <Kicker text="THE SLOW WAY" color={PINK} at={146} until={250} />
      <Kicker text="HALVE IT" color={GREEN} at={258} until={850} />
      <Kicker text="THE SCALE" color={INDIGO} at={866} until={1090} />

      <RangeBoard
        n={N}
        target={TARGET}
        view={view}
        y0={380}
        scan={scanning ? { p: scanP } : undefined}
        pill={scanning ? scanPill : undefined}
        opacity={boardOp}
      />

      <FoundBurst at={843} y={380 + 600 + 75} />
      <StatChip label="Linear · 1,000,000 numbers" value="up to 1,000,000 guesses" color={PINK} x={70} y={420} w={940} at={858} />
      <StatChip label="Binary · 1,000,000 numbers" value={`${GUESS_COUNT} guesses`} color={GREEN} x={70} y={610} w={940} at={872} />
      <StatChip label="Binary · 1,000,000,000 numbers" value="30 guesses" color={GOLD} x={70} y={800} w={940} at={912} />

      {doublingIn > 0.01 ? (
        <div
          style={{
            position: 'absolute',
            top: 1040,
            left: 0,
            right: 0,
            textAlign: 'center',
            opacity: doublingIn,
            transform: `translateY(${(1 - doublingIn) * 16}px)`,
          }}
        >
          <div style={{ fontFamily: FONT_MONO, fontWeight: 700, fontSize: 56, color: '#fff' }}>
            <span style={{ color: INDIGO }}>×2</span> numbers = <span style={{ color: GOLD }}>+1</span> guess
          </div>
          <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 34, color: 'rgba(255,255,255,0.6)', marginTop: 14 }}>
            2²⁰ = 1,048,576 · 2³⁰ = 1,073,741,824
          </div>
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

// Living backdrop: soft drifting brand-colour glows + faint dot grid (brand §5). Whole-number
// sine cycles over the full 1230 frames, so frame 0 == last frame and the loop stays seamless.
const TOTAL = 1230;
const LivingBackdrop: React.FC = () => {
  const frame = useCurrentFrame();
  const a = (2 * Math.PI * frame) / TOTAL;
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
      {blob(220, 420, 520, 'rgba(99,102,241,0.22)', 2, 0, 90)}
      {blob(880, 1000, 560, 'rgba(155,124,196,0.16)', 3, 2, 80)}
      {blob(300, 1560, 520, 'rgba(77,184,168,0.16)', 2, 4, 100)}
      <AbsoluteFill style={{ backgroundImage: 'radial-gradient(rgba(255,255,255,0.07) 1.5px, transparent 1.6px)', backgroundSize: '54px 54px', opacity: 0.6 }} />
    </AbsoluteFill>
  );
};

// FOUND burst: glow rings pulse out of the bar when the 20th guess lands.
const FoundBurst: React.FC<{ at: number; y: number }> = ({ at, y }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {[0, 7, 14].map((d, i) => {
        const p = prog(frame, at + d, at + d + 34);
        if (p <= 0 || p >= 1) return null;
        const size = 160 + p * 760;
        const col = i === 1 ? GOLD : GREEN;
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: 540 - size / 2,
              top: y - size / 2,
              width: size,
              height: size,
              borderRadius: '50%',
              border: `${6 - p * 4}px solid ${col}`,
              opacity: (1 - p) * 0.7,
              boxShadow: `0 0 50px ${col}66`,
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};

const LoopScene: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ opacity: prog(frame, 0, 12) }}>
      <HookScene mode="grow" />
    </AbsoluteFill>
  );
};

// =============================================================================
// MAIN COMPONENT
// =============================================================================
const Short13BinSearch: React.FC = () => {
  // Studio-only preview of the finished voice+SFX mix. Never in a render: audio is muxed after, so this would double it.
  const { isStudio } = getRemotionEnvironment();
  return (
    <AbsoluteFill style={{ background: '#0e141a' }}>
      <ShortsBackdrop base="#0e141a" glow="#16222e" />
      <LivingBackdrop />
      <Sequence from={0} durationInFrames={102}>
        <HookScene mode="settle" />
      </Sequence>
      <Sequence from={102} durationInFrames={1098}>
        <GameScene />
      </Sequence>
      <Sequence from={1188} durationInFrames={42}>
        <LoopScene />
      </Sequence>
      <Captions lines={VO} y={1500} accent={GOLD} />
      <ProgressBar color={GOLD} />
      {isStudio ? <Audio src={staticFile('projects/short-13/preview-mix.mp3')} /> : null}
    </AbsoluteFill>
  );
};

export default Short13BinSearch;
