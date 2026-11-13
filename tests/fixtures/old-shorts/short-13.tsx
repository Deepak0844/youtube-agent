// Old short short-13.tsx from the owner's old app, converted for the engine's renderer (old-kit-import): imports
// '../../lib/<x>' -> 'yt-old/<x>', vo.gen.ts inlined, compositionConfig -> meta, the studio-only audio preview removed.
import React from 'react';
import { AbsoluteFill, Easing, Sequence, useCurrentFrame } from 'remotion';
import { BigTitle, Captions, Kicker, ProgressBar, ShortsBackdrop, StatChip, prog } from 'yt-old/shorts';
import { RangeBoard, binarySearchSteps, searchViewAt } from 'yt-old/algo';
import { FONT_DISPLAY, FONT_MONO } from 'yt-old/fonts';

// Narration word times of the old app's recorded voice (was vo.gen.ts), inlined so the scene is one file.
import type { VoLine } from 'yt-old/shorts';

const VO: VoLine[] = [
  { text: 'A million numbers. Twenty guesses. That\'s all it takes.', start: 0.4, end: 4.06, words: [{ w: 'A', start: 0.4, end: 0.485 }, { w: 'million', start: 0.644, end: 0.984 }, { w: 'numbers.', start: 1.037, end: 1.408 }, { w: 'Twenty', start: 1.44, end: 1.747 }, { w: 'guesses.', start: 1.801, end: 2.278 }, { w: 'That\'s', start: 2.437, end: 2.639 }, { w: 'all', start: 2.702, end: 2.893 }, { w: 'it', start: 2.936, end: 2.999 }, { w: 'takes.', start: 3.031, end: 4.05 }] },
  { text: 'I\'m thinking of a number between one and one million.', start: 4.1, end: 7.02, words: [{ w: 'I\'m', start: 4.1, end: 4.286 }, { w: 'thinking', start: 4.332, end: 4.622 }, { w: 'of', start: 4.657, end: 4.704 }, { w: 'a', start: 4.75, end: 4.773 }, { w: 'number', start: 4.82, end: 5.017 }, { w: 'between', start: 5.064, end: 5.354 }, { w: 'one', start: 5.435, end: 5.586 }, { w: 'and', start: 5.609, end: 5.679 }, { w: 'one', start: 5.76, end: 5.934 }, { w: 'million.', start: 5.981, end: 7.026 }] },
  { text: 'Guessing one by one could take a million tries.', start: 8.2, end: 11.4, words: [{ w: 'Guessing', start: 8.2, end: 8.606 }, { w: 'one', start: 8.688, end: 8.862 }, { w: 'by', start: 8.897, end: 9.024 }, { w: 'one', start: 9.106, end: 9.28 }, { w: 'could', start: 9.326, end: 9.465 }, { w: 'take', start: 9.5, end: 9.663 }, { w: 'a', start: 9.698, end: 9.721 }, { w: 'million', start: 9.779, end: 10.081 }, { w: 'tries.', start: 10.127, end: 11.404 }] },
  { text: 'So guess the middle instead.', start: 11.8, end: 13.61, words: [{ w: 'So', start: 11.8, end: 11.997 }, { w: 'guess', start: 12.055, end: 12.253 }, { w: 'the', start: 12.288, end: 12.357 }, { w: 'middle', start: 12.404, end: 12.648 }, { w: 'instead.', start: 12.682, end: 13.611 }] },
  { text: 'Five hundred thousand. Too low.', start: 14.0, end: 15.95, words: [{ w: 'Five', start: 14.0, end: 14.214 }, { w: 'hundred', start: 14.234, end: 14.41 }, { w: 'thousand.', start: 14.429, end: 14.848 }, { w: 'Too', start: 15.082, end: 15.258 }, { w: 'low.', start: 15.316, end: 15.95 }] },
  { text: 'Seven fifty. Too high.', start: 16.0, end: 18.15, words: [{ w: 'Seven', start: 16.0, end: 16.295 }, { w: 'fifty.', start: 16.348, end: 16.801 }, { w: 'Too', start: 16.96, end: 17.148 }, { w: 'high.', start: 17.212, end: 18.15 }] },
  { text: 'Every guess deletes half of what\'s left.', start: 18.2, end: 20.47, words: [{ w: 'Every', start: 18.2, end: 18.49 }, { w: 'guess', start: 18.548, end: 18.746 }, { w: 'deletes', start: 18.792, end: 19.094 }, { w: 'half', start: 19.164, end: 19.384 }, { w: 'of', start: 19.431, end: 19.477 }, { w: 'what\'s', start: 19.524, end: 19.709 }, { w: 'left.', start: 19.756, end: 20.476 }] },
  { text: 'Half, then half, then half again.', start: 24.2, end: 26.51, words: [{ w: 'Half,', start: 24.2, end: 24.525 }, { w: 'then', start: 24.548, end: 24.699 }, { w: 'half,', start: 24.792, end: 25.082 }, { w: 'then', start: 25.106, end: 25.268 }, { w: 'half', start: 25.349, end: 25.57 }, { w: 'again.', start: 25.628, end: 26.522 }] },
  { text: 'Until, on the twentieth guess, there\'s only one number left.', start: 27.0, end: 30.38, words: [{ w: 'Until,', start: 27.0, end: 27.476 }, { w: 'on', start: 27.511, end: 27.639 }, { w: 'the', start: 27.673, end: 27.743 }, { w: 'twentieth', start: 27.789, end: 28.161 }, { w: 'guess,', start: 28.207, end: 28.416 }, { w: 'there\'s', start: 28.44, end: 28.66 }, { w: 'only', start: 28.695, end: 28.881 }, { w: 'one', start: 28.95, end: 29.101 }, { w: 'number', start: 29.136, end: 29.345 }, { w: 'left.', start: 29.392, end: 30.39 }] },
  { text: 'Make it a billion numbers? Just thirty guesses.', start: 32.2, end: 35.49, words: [{ w: 'Make', start: 32.2, end: 32.432 }, { w: 'it', start: 32.467, end: 32.525 }, { w: 'a', start: 32.548, end: 32.572 }, { w: 'billion', start: 32.641, end: 32.978 }, { w: 'numbers?', start: 33.024, end: 33.547 }, { w: 'Just', start: 33.791, end: 34.0 }, { w: 'thirty', start: 34.069, end: 34.371 }, { w: 'guesses.', start: 34.429, end: 35.497 }] },
  { text: 'Every doubling costs one guess.', start: 35.8, end: 37.65, words: [{ w: 'Every', start: 35.8, end: 36.09 }, { w: 'doubling', start: 36.148, end: 36.462 }, { w: 'costs', start: 36.52, end: 36.787 }, { w: 'one', start: 36.857, end: 37.054 }, { w: 'guess.', start: 37.1, end: 37.658 }] },
  { text: 'That\'s binary search.', start: 38.5, end: 40.07, words: [{ w: 'That\'s', start: 38.5, end: 38.825 }, { w: 'binary', start: 38.895, end: 39.359 }, { w: 'search.', start: 39.429, end: 40.079 }] },
];


// =============================================================================
// COMPOSITION CONFIG
// =============================================================================
export const meta = { durationInFrames: 1230, fps: 30, width: 1080, height: 1920 };

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
    </AbsoluteFill>
  );
};

export default Short13BinSearch;
