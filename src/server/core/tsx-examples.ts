// Two short, working scenes shown to the model as style references (tsx-prompt.ts). Each one passes checkTsx verbatim: the unit
// test runs the checker over them, so an example can never teach a pattern the checker refuses.

/** Bars that grow and fall back: frame 0 is fully drawn and the last frame equals frame 0 (a loop). */
export const TSX_EXAMPLE_LOOP = `import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";

const PEAKS = [0.9, 0.55, 1, 0.7, 0.4];

export default function Scene() {
  const frame = useCurrentFrame();
  const ease = Easing.bezier(0.4, 0, 0.2, 1);
  return (
    <AbsoluteFill style={{ backgroundColor: "#0b1020", fontFamily: "sans-serif" }}>
      <div style={{ position: "absolute", left: 80, right: 80, top: 160, color: "#ffffff", fontSize: 96, fontWeight: 800, lineHeight: 1.1 }}>
        Five signals, one loop
      </div>
      <div style={{ position: "absolute", left: 80, right: 80, top: 520, height: 800, display: "flex", alignItems: "flex-end", gap: 24 }}>
        {PEAKS.map((peak, i) => {
          const h = interpolate(frame, [0, 135, 269], [0.2, peak, 0.2], { easing: ease });
          return <div key={i} style={{ flex: 1, height: \`\${Math.round(h * 100)}%\`, backgroundColor: "#ffb703", borderRadius: 24 }} />;
        })}
      </div>
    </AbsoluteFill>
  );
}

export const meta = { durationInFrames: 270, fps: 30, width: 1080, height: 1920 };
`;

/** Cards timed with Sequence (from = the frame a narrated word starts); the first card is already on screen at frame 0 and the last frame repeats it. */
export const TSX_EXAMPLE_SEQUENCE = `import { AbsoluteFill, Easing, Sequence, interpolate, useCurrentFrame } from "remotion";

const CARDS = [
  { from: 0, length: 90, label: "Signal in", color: "#4cc9f0", enter: false },
  { from: 90, length: 90, label: "Gate opens", color: "#f72585", enter: true },
  { from: 180, length: 60, label: "Signal out", color: "#ffb703", enter: true },
  { from: 240, length: 30, label: "Signal in", color: "#4cc9f0", enter: false },
];

const Card = ({ label, color, enter }: { label: string; color: string; enter: boolean }) => {
  const f = useCurrentFrame(); // inside a Sequence this counts from 0 at the Sequence start
  const rise = interpolate(f, [0, 12], [enter ? 80 : 0, 0], { easing: Easing.bezier(0.2, 0.8, 0.2, 1), extrapolateRight: "clamp" });
  return (
    <div style={{ position: "absolute", left: 90, right: 90, top: 520, height: 560, borderRadius: 48, backgroundColor: color, display: "flex", alignItems: "center", justifyContent: "center", transform: \`translateY(\${rise}px)\` }}>
      <span style={{ color: "#0b1020", fontSize: 110, fontWeight: 800, fontFamily: "sans-serif" }}>{label}</span>
    </div>
  );
};

export default function Scene() {
  return (
    <AbsoluteFill style={{ backgroundColor: "#0b1020" }}>
      {CARDS.map((c, i) => (
        <Sequence key={i} from={c.from} durationInFrames={c.length}>
          <Card label={c.label} color={c.color} enter={c.enter} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
}

export const meta = { durationInFrames: 270, fps: 30, width: 1080, height: 1920 };
`;
