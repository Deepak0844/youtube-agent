// A tiny scene that passes checkTsx and the type-check, 270 frames: a stand-in "model reply" for the author-stage tests.
export const GOOD_SCENE = `import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";

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
