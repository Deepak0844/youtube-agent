import React from 'react';
import { AbsoluteFill, Sequence, useCurrentFrame } from 'remotion';
import { Captions, Kicker, ProgressBar, ShortsBackdrop, StatChip, EASE_OUT, EASE_INOUT, prog } from '../../lib/shorts';
import { TerminalWindow, TermLine } from '../../lib/terminal';
import { FONT_BODY } from '../../fonts';
import { VO } from './vo.gen';

// =============================================================================
// COMPOSITION CONFIG
// =============================================================================
export const compositionConfig = {
  id: 'Short14Docker',
  durationInSeconds: 42,
  fps: 30,
  width: 1080,
  height: 1920,
};

// =============================================================================
// STYLE
// =============================================================================
const INDIGO = '#6366F1';
const TEAL = '#4db8a8';
const PINK = '#e8879f';
const MUTED = '#6b6b7b';

// The terminal frame — the persistent canvas. Same box in the main session and the
// loop remount so the loop's frozen hero overlays the hook's frame-0 pixel-for-pixel.
const BOX = { x: 58, y: 300, w: 964, h: 760 };
const TERM = { fontSize: 25, lineH: 38, pad: 26, title: 'myapp — zsh' } as const;

// The one terminal session for the whole video (see script.md): laptop works, the
// same command fails on the server, a Dockerfile fixes it, the server re-runs clean.
// `at` cues are global frames, keyed to beat starts from beats.json (setup 121,
// reveal 413, hero success 700).
const SESSION: TermLine[] = [
  // hook — pre-revealed success, already resolved at frame 0
  { kind: 'cmd', text: 'docker run myapp', at: -5, prompt: 'ops@prod-server' },
  { kind: 'ok', text: 'Server running on :5000', at: -5 },
  // setup — works on the laptop
  { kind: 'cmd', text: 'python app.py', type: true, at: 121, prompt: 'you@laptop', gap: 18 },
  { kind: 'ok', text: 'Server running on :5000', at: 150 },
  // setup — same command, the server
  { kind: 'cmd', text: 'python app.py', type: true, at: 200, prompt: 'ops@prod-server', gap: 14 },
  { kind: 'err', text: "ModuleNotFoundError: No module named 'flask'", at: 230 },
  // reveal — the Dockerfile cascades in
  { kind: 'out', text: 'FROM python:3.11', at: 420, gap: 18 },
  { kind: 'out', text: 'COPY . .', at: 440 },
  { kind: 'out', text: 'RUN pip install -r requirements.txt', at: 460 },
  { kind: 'out', text: 'CMD ["python", "app.py"]', at: 480 },
  // reveal — build + run, this time inside the container
  { kind: 'cmd', text: 'docker build -t myapp .', type: true, at: 540, prompt: 'ops@prod-server', gap: 18 },
  { kind: 'ok', text: 'Successfully built myapp', at: 600 },
  { kind: 'cmd', text: 'docker run myapp', type: true, at: 660, prompt: 'ops@prod-server' },
  { kind: 'ok', text: 'Server running on :5000', at: 700, hl: TEAL },
];

// loop — the same frozen hero, remounted fresh so it can grow 1 -> 1.06 and land
// exactly on the hook's frame-0 (which starts at the settled 1.06).
const LOOP_LINES: TermLine[] = [
  { kind: 'cmd', text: 'docker run myapp', at: -5, prompt: 'ops@prod-server' },
  { kind: 'ok', text: 'Server running on :5000', at: -5 },
];

// =============================================================================
// THESIS BADGE — a small docked ribbon on the terminal's corner, not a big rotated
// Stamp (the text is a tagline, not a punch word). Scales/fades with its parent.
// =============================================================================
const ThesisBadge: React.FC<{ at?: number; until?: number }> = ({ at = 0, until }) => {
  const frame = useCurrentFrame();
  const inP = EASE_OUT(prog(frame, at, at + 10));
  const outP = until === undefined ? 1 : 1 - prog(frame, until - 10, until);
  const o = inP * outP;
  if (o <= 0.01) return null;
  return (
    <div
      style={{
        position: 'absolute',
        right: 1080 - (BOX.x + BOX.w) + 24,
        top: BOX.y - 32,
        opacity: o,
        transform: `translateY(${(1 - inP) * 10}px)`,
        fontFamily: FONT_BODY,
        fontWeight: 600,
        fontSize: 22,
        letterSpacing: 2,
        textTransform: 'uppercase',
        color: TEAL,
        border: `2px solid ${TEAL}`,
        borderRadius: 999,
        padding: '10px 22px',
        background: '#0d1117',
        boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
        whiteSpace: 'nowrap',
      }}
    >
      Runs the same everywhere
    </div>
  );
};

// =============================================================================
// SCENES
// =============================================================================
// Wraps the terminal + badge(s) in one scale/opacity envelope so the hook's settle
// (1.06 -> 1) and the loop's grow (1 -> 1.06) land on identical pixels, and so the
// whole stack dims together once the twist's stat chips take over.
const TerminalStage: React.FC<{
  lines: TermLine[];
  scaleMode: 'settle' | 'grow' | 'none';
  dimFrom?: number;
  children?: React.ReactNode;
}> = ({ lines, scaleMode, dimFrom, children }) => {
  const frame = useCurrentFrame();
  const scale =
    scaleMode === 'settle'
      ? 1.06 - 0.06 * EASE_INOUT(prog(frame, 0, 26))
      : scaleMode === 'grow'
      ? 1.0 + 0.06 * EASE_INOUT(prog(frame, 0, 100))
      : 1;
  const dim = dimFrom !== undefined ? 1 - 0.85 * EASE_OUT(prog(frame, dimFrom, dimFrom + 36)) : 1;
  return (
    <div style={{ position: 'absolute', inset: 0, transformOrigin: '50% 38%', transform: `scale(${scale})`, opacity: dim }}>
      <TerminalWindow
        box={BOX}
        lines={lines}
        title={TERM.title}
        promptPath="you@laptop"
        fontSize={TERM.fontSize}
        lineH={TERM.lineH}
        pad={TERM.pad}
        appearAt={-999}
      />
      {children}
    </div>
  );
};

// =============================================================================
// MAIN COMPONENT
// =============================================================================
const Short14Docker: React.FC = () => {
  return (
    <AbsoluteFill style={{ background: '#0d1117' }}>
      <ShortsBackdrop base="#0d1117" glow="#161b22" />

      {/* persistent terminal — mounted from frame 0 so `at` == global frame.
          Overlaps 40 frames into the loop for a crossfade. */}
      <Sequence from={0} durationInFrames={1176} name="session">
        <FadeOut from={1136} to={1176}>
          <TerminalStage lines={SESSION} scaleMode="settle" dimFrom={892}>
            <ThesisBadge at={-5} until={110} />
            <ThesisBadge at={700} until={42000} />
          </TerminalStage>
        </FadeOut>
      </Sequence>

      {/* section labels (global time) */}
      <Kicker text="IT WORKS ON MY MACHINE" color={MUTED} y={190} at={121} until={229} />
      <Kicker text="...NOT ON THIS ONE" color={PINK} y={190} at={230} until={413} />
      <Kicker text="THE FIX: A DOCKERFILE" color={INDIGO} y={190} at={413} until={892} />

      {/* twist — the comparison that answers "why Docker, not a VM" */}
      <StatChip label="Virtual machine" value="full OS · tens of GBs · slow boot" color={PINK} x={160} y={430} w={760} at={892} />
      <StatChip label="Container" value="just the app · tens of MBs · instant" color={TEAL} x={160} y={700} w={760} at={1012} />

      {/* loop — dissolve back to a fresh frozen hero; last frame == frame 0.
          Local frame 0 == global frame 1136 (frames inside a Sequence are local). */}
      <Sequence from={1136} durationInFrames={124} name="loop">
        <FadeIn from={0} to={40}>
          <TerminalStage lines={LOOP_LINES} scaleMode="grow">
            <ThesisBadge at={-999} />
          </TerminalStage>
        </FadeIn>
      </Sequence>

      <Captions lines={VO} y={1270} accent={INDIGO} />
      <ProgressBar color={INDIGO} />
    </AbsoluteFill>
  );
};

// Root-relative opacity envelopes (children keep their own global frame).
const FadeOut: React.FC<{ from: number; to: number; children: React.ReactNode }> = ({ from, to, children }) => {
  const frame = useCurrentFrame();
  return <AbsoluteFill style={{ opacity: 1 - prog(frame, from, to) }}>{children}</AbsoluteFill>;
};
const FadeIn: React.FC<{ from: number; to: number; children: React.ReactNode }> = ({ from, to, children }) => {
  const frame = useCurrentFrame();
  return <AbsoluteFill style={{ opacity: prog(frame, from, to) }}>{children}</AbsoluteFill>;
};

export default Short14Docker;
