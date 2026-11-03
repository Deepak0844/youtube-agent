// Two full, working scenes shown to the model as references (tsx-prompt.ts). Both import from "yt-kit" and pass checkTsx and the
// real type-check verbatim: the unit tests run both over them, so an example can never teach a pattern the checker refuses.
// Their timings are examples only: a real scene takes every cue frame from the word times in the task.

/** A machine story: the payoff is on screen at frame 0, one persistent canvas evolves, rotors land on a symmetric pose, the last frame equals frame 0. */
export const TSX_EXAMPLE_ELECTRICITY = `import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Backdrop, Bulb, Counter, Donut, Generator, Label, Place, Pylon, SolarPanel, Stage, WindTurbine, Wire, ramp, rotorAngle, win } from "yt-kit";

const TOTAL = 900;
// [frame, degrees per frame] keys; the cues below are the frames of the spoken words (here: "generator" 190, "wind" 430, "percent" 670).
const SPEED = [[0, 0], [60, 3], [200, 14], [500, 16], [800, 4], [899, 3]] as const;

export default function Scene() {
  const f = useCurrentFrame();
  const spin = rotorAngle(f, TOTAL, SPEED, 45); // 8 blades: same look every 45 degrees
  const windSpin = rotorAngle(f, TOTAL, SPEED, 120); // 3 blades: every 120
  const pulse = (3 * f) / (TOTAL - 1); // whole cycles, so the last frame repeats frame 0
  const grid = 1 - ramp(f, 150, 190) + ramp(f, 800, 860); // frame 0 and the last frame show the finished grid
  const gen = win(f, 190, 230, 410, 450);
  const green = win(f, 430, 470, 650, 690);
  const share = win(f, 670, 710, 790, 830);
  const dial = ramp(f, 700, 770);

  return (
    <AbsoluteFill>
      <Backdrop />
      <Stage headline="How electricity is really made" opacity={grid}>
        <g opacity={grid}>
          <Pylon x={250} baseY={1320} h={380} />
          <Pylon x={830} baseY={1320} h={380} />
          <WindTurbine x={110} baseY={1320} h={440} rot={windSpin} />
          <SolarPanel cx={900} cy={1010} w={380} lit={1} beams={0.5} flow={pulse * 3} t={f} />
          <Wire pts={[[540, 930], [540, 1320]]} phase={pulse * 2} color="accent" width={10} n={4} />
          <Place x={540} y={640} w={440} h={440}>
            <Bulb cx={0} cy={0} s={1.3} glow={1} />
          </Place>
        </g>
        <g opacity={gen}>
          <Place x={540} y={860} w={700} h={700}>
            <Generator cx={0} cy={0} r={340} rot={spin} glow={0.4 + 0.6 * ramp(f, 260, 330)} blur={ramp(f, 200, 260) * 0.8} />
          </Place>
          <Wire pts={[[880, 860], [960, 860], [960, 1240]]} phase={pulse * 2} color="accent3" width={10} n={4} />
        </g>
        <g opacity={green}>
          <WindTurbine x={270} baseY={1300} h={520} rot={windSpin * 1.8} />
          <SolarPanel cx={760} cy={1000} w={520} lit={ramp(f, 480, 560)} beams={ramp(f, 500, 540)} flow={pulse * 3} t={f} />
          <Wire pts={[[270, 1300], [270, 1340], [760, 1340]]} phase={pulse * 2} color="accent3" width={10} n={5} />
        </g>
        <g opacity={share}>
          <Donut cx={540} cy={820} r={290} pct={0.21 * dial} label={Math.round(21 * dial) + "%"} />
        </g>
      </Stage>
      {/* labels sit NEXT to an object on an explicit side: above the generator, above the turbine hub, below the panel */}
      <Label text="Spin a magnet" ax={540} ay={520} side="top" color="accent" at={215} until={400} />
      <Label text="Wind" ax={270} ay={590} side="top" color="accent3" at={430} until={640} />
      <Label text="Sun" ax={760} ay={1180} side="bottom" color="accent" at={490} until={640} />
      <div style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, opacity: gen }}>
        <Counter from={0} to={120} start={250} end={330} x={540} y={1290} size={110} color="accent" suffix=" V" />
      </div>
    </AbsoluteFill>
  );
}

export const meta = { durationInFrames: 900, fps: 30, width: 1080, height: 1920 };
`;


/** An algorithm story: the finished board first (frame 0), one persistent board whose steps land on the spoken words, a counter, and a return to frame 0. */
export const TSX_EXAMPLE_SEARCH = `import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { Backdrop, Counter, FONTS, Label, PALETTE, Stage, StatusBadge, ramp, win } from "yt-kit";

const TARGET = 12; // 16 numbers (cells 0 to 15); binary search needs 4 guesses for cell 12
// Each guess: the range still alive, the cell guessed, and the frame its word is spoken ("middle" 150, "again" 270, "again" 390, "found" 510).
const STEPS = [
  { lo: 0, hi: 15, mid: 7, at: 150 },
  { lo: 8, hi: 15, mid: 11, at: 270 },
  { lo: 12, hi: 15, mid: 13, at: 390 },
  { lo: 12, hi: 12, mid: 12, at: 510 },
];

export default function Scene() {
  const f = useCurrentFrame();
  const hook = 1 - ramp(f, 120, 150) + ramp(f, 740, 800); // frame 0 and the last frame show the finished board
  const lit = Math.max(hook, ramp(f, 510, 540)); // the answer is lit
  let s = 0; // index of the current guess (0 until the first word)
  for (let i = 0; i < 4; i++) {
    if (f >= STEPS[i]!.at) s = i;
  }
  const now = STEPS[s]!;
  const zoom = interpolate(f, [0, 405, 809], [1, 1.04, 1]); // a slow push-in that returns

  return (
    <AbsoluteFill>
      <Backdrop />
      <Stage headline="16 numbers. 4 guesses." opacity={hook}>
        <g transform={"translate(540 960) scale(" + zoom + ") translate(-540 -960)"}>
          {Array.from({ length: 16 }).map((_, i) => {
            const x = 150 + (i % 4) * 260;
            const y = 560 + Math.floor(i / 4) * 190;
            const alive = i >= now.lo && i <= now.hi;
            const guessed = f >= STEPS[0]!.at - 20 && i === now.mid;
            const gold = i === TARGET && lit > 0.5;
            return (
              <g key={i} opacity={alive || lit > 0.99 ? 1 : 0.25}>
                <rect x={x - 110} y={y - 70} width={220} height={140} rx={28} fill={gold ? PALETTE.accent : PALETTE.surface} stroke={guessed && hook < 0.5 ? PALETTE.accent3 : PALETTE.muted} strokeWidth={guessed && hook < 0.5 ? 10 : 4} />
                <text x={x} y={y + 22} textAnchor="middle" fontFamily={FONTS.mono} fontWeight={700} fontSize={64} fill={gold ? PALETTE.bg : PALETTE.text}>{i + 1}</text>
              </g>
            );
          })}
        </g>
        <StatusBadge kind="ok" x={900} y={425} r={55} at={510} opacity={win(f, 510, 525, 700, 740)} />
      </Stage>
      {/* one verdict at a time, above the board (its top edge is y 490), never on a cell */}
      <Label text="Too low" ax={540} ay={490} side="top" color="accent2" at={160} until={265} />
      <Label text="Too low" ax={540} ay={490} side="top" color="accent2" at={280} until={385} />
      <Label text="Too high" ax={540} ay={490} side="top" color="accent2" at={400} until={505} />
      <div style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, opacity: win(f, 140, 170, 700, 740) }}>
        <Counter from={0} to={4} start={150} end={510} x={540} y={1310} size={90} color="accent" prefix="Guesses: " />
      </div>
    </AbsoluteFill>
  );
}

export const meta = { durationInFrames: 810, fps: 30, width: 1080, height: 1920 };
`;

/** One short, style-aware pop-in (the spring numbers and the rise come from the chosen style). Tested inside a full file; shown as a snippet. */
export const TSX_SNIPPET_MOTION = `const p = spring({ frame: f - 30, fps: 30, config: { stiffness: MOTION.stiffness, damping: MOTION.damping } }); // arrives at frame 30
<div style={{ opacity: Math.min(1, p), transform: "translateY(" + (1 - p) * MOTION.rise + "px)", color: PALETTE.text, fontFamily: FONTS.body }}>one idea</div>
`;
