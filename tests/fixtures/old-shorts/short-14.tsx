// Old short short-14.tsx from the owner's old app, converted for the engine's renderer (old-kit-import): imports
// '../../lib/<x>' -> 'yt-old/<x>', vo.gen.ts inlined, compositionConfig -> meta, the studio-only audio preview removed.
import React from 'react';
import { AbsoluteFill, Sequence, useCurrentFrame } from 'remotion';
import { Captions, Kicker, ProgressBar, ShortsBackdrop, StatChip, EASE_OUT, EASE_INOUT, prog } from 'yt-old/shorts';
import { TerminalWindow, type TermLine } from 'yt-old/terminal';
import { FONT_BODY } from 'yt-old/fonts';

// Narration word times of the old app's recorded voice (was vo.gen.ts), inlined so the scene is one file.
import type { VoLine } from 'yt-old/shorts';

const VO: VoLine[] = [
  { text: 'One command. The same app. Any machine, every time.', start: 0.4, end: 3.99, words: [{ w: 'One', start: 0.4, end: 0.549 }, { w: 'command.', start: 0.586, end: 0.978 }, { w: 'The', start: 1.099, end: 1.193 }, { w: 'same', start: 1.23, end: 1.435 }, { w: 'app.', start: 1.472, end: 1.743 }, { w: 'Any', start: 2.05, end: 2.228 }, { w: 'machine,', start: 2.274, end: 2.73 }, { w: 'every', start: 2.871, end: 3.076 }, { w: 'time.', start: 3.113, end: 3.98 }] },
  { text: 'On my laptop, this runs perfectly.', start: 4.03, end: 6.51, words: [{ w: 'On', start: 4.03, end: 4.19 }, { w: 'my', start: 4.239, end: 4.309 }, { w: 'laptop,', start: 4.378, end: 4.836 }, { w: 'this', start: 4.857, end: 4.987 }, { w: 'runs', start: 5.046, end: 5.235 }, { w: 'perfectly.', start: 5.294, end: 6.5 }] },
  { text: 'I push the same code to the server. It crashes.', start: 6.55, end: 9.75, words: [{ w: 'I', start: 6.55, end: 6.608 }, { w: 'push', start: 6.701, end: 6.887 }, { w: 'the', start: 6.933, end: 7.003 }, { w: 'same', start: 7.038, end: 7.235 }, { w: 'code', start: 7.281, end: 7.479 }, { w: 'to', start: 7.502, end: 7.548 }, { w: 'the', start: 7.595, end: 7.665 }, { w: 'server.', start: 7.711, end: 8.187 }, { w: 'It', start: 8.396, end: 8.535 }, { w: 'crashes.', start: 8.582, end: 9.754 }] },
  { text: 'Wrong Python version. A missing package.', start: 10.55, end: 13.32, words: [{ w: 'Wrong', start: 10.55, end: 10.875 }, { w: 'Python', start: 10.945, end: 11.316 }, { w: 'version.', start: 11.374, end: 11.815 }, { w: 'A', start: 12.024, end: 12.106 }, { w: 'missing', start: 12.175, end: 12.442 }, { w: 'package.', start: 12.5, end: 13.336 }] },
  { text: 'So we write a Dockerfile — exact versions, exact dependencies.', start: 13.77, end: 17.73, words: [{ w: 'So', start: 13.77, end: 13.951 }, { w: 'we', start: 14.017, end: 14.14 }, { w: 'write', start: 14.188, end: 14.368 }, { w: 'a', start: 14.387, end: 14.406 }, { w: 'Dockerfile', start: 14.454, end: 15.004 }, { w: '—', start: 15.033, end: 15.109 }, { w: 'exact', start: 15.469, end: 15.745 }, { w: 'versions,', start: 15.793, end: 16.296 }, { w: 'exact', start: 16.495, end: 16.789 }, { w: 'dependencies.', start: 16.818, end: 17.72 }] },
  { text: 'Docker builds an image, and runs it in a container.', start: 17.77, end: 21.57, words: [{ w: 'Docker', start: 17.77, end: 18.2 }, { w: 'builds', start: 18.292, end: 18.618 }, { w: 'an', start: 18.652, end: 18.722 }, { w: 'image,', start: 18.792, end: 19.256 }, { w: 'and', start: 19.43, end: 19.581 }, { w: 'runs', start: 19.662, end: 19.906 }, { w: 'it', start: 19.953, end: 20.022 }, { w: 'in', start: 20.069, end: 20.138 }, { w: 'a', start: 20.173, end: 20.196 }, { w: 'container.', start: 20.243, end: 21.578 }] },
  { text: 'A container shares the host\'s kernel, not a whole OS.', start: 21.77, end: 25.73, words: [{ w: 'A', start: 21.77, end: 21.865 }, { w: 'container', start: 21.929, end: 22.279 }, { w: 'shares', start: 22.332, end: 22.577 }, { w: 'the', start: 22.62, end: 22.683 }, { w: 'host\'s', start: 22.726, end: 23.012 }, { w: 'kernel,', start: 23.065, end: 23.543 }, { w: 'not', start: 23.735, end: 23.862 }, { w: 'a', start: 23.905, end: 23.926 }, { w: 'whole', start: 23.958, end: 24.159 }, { w: 'OS.', start: 24.212, end: 25.72 }] },
  { text: 'That\'s why it starts in milliseconds, not minutes.', start: 25.77, end: 28.74, words: [{ w: 'That\'s', start: 25.77, end: 26.014 }, { w: 'why', start: 26.049, end: 26.176 }, { w: 'it', start: 26.234, end: 26.304 }, { w: 'starts', start: 26.35, end: 26.629 }, { w: 'in', start: 26.676, end: 26.745 }, { w: 'milliseconds,', start: 26.827, end: 27.442 }, { w: 'not', start: 27.477, end: 27.616 }, { w: 'minutes.', start: 27.662, end: 28.742 }] },
  { text: 'A virtual machine packs a whole OS. Tens of gigabytes.', start: 29.73, end: 33.69, words: [{ w: 'A', start: 29.73, end: 29.836 }, { w: 'virtual', start: 29.91, end: 30.26 }, { w: 'machine', start: 30.314, end: 30.643 }, { w: 'packs', start: 30.686, end: 30.93 }, { w: 'a', start: 30.972, end: 31.004 }, { w: 'whole', start: 31.068, end: 31.322 }, { w: 'OS.', start: 31.376, end: 31.949 }, { w: 'Tens', start: 32.247, end: 32.586 }, { w: 'of', start: 32.629, end: 32.682 }, { w: 'gigabytes.', start: 32.735, end: 33.68 }] },
  { text: 'A container packs just the app. Tens of megabytes.', start: 33.73, end: 37.06, words: [{ w: 'A', start: 33.73, end: 33.846 }, { w: 'container', start: 33.904, end: 34.252 }, { w: 'packs', start: 34.31, end: 34.554 }, { w: 'just', start: 34.624, end: 34.833 }, { w: 'the', start: 34.868, end: 34.937 }, { w: 'app.', start: 35.007, end: 35.332 }, { w: 'Tens', start: 35.506, end: 35.785 }, { w: 'of', start: 35.831, end: 35.878 }, { w: 'megabytes.', start: 35.948, end: 37.074 }] },
  { text: 'Same image, same result, anywhere. That\'s why we need Docker.', start: 37.86, end: 41.52, words: [{ w: 'Same', start: 37.86, end: 38.173 }, { w: 'image,', start: 38.208, end: 38.533 }, { w: 'same', start: 38.557, end: 38.777 }, { w: 'result,', start: 38.812, end: 39.3 }, { w: 'anywhere.', start: 39.427, end: 39.961 }, { w: 'That\'s', start: 40.205, end: 40.403 }, { w: 'why', start: 40.426, end: 40.507 }, { w: 'we', start: 40.565, end: 40.623 }, { w: 'need', start: 40.67, end: 40.809 }, { w: 'Docker.', start: 40.844, end: 41.529 }] },
];


// =============================================================================
// COMPOSITION CONFIG
// =============================================================================
export const meta = { durationInFrames: 1260, fps: 30, width: 1080, height: 1920 };

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
