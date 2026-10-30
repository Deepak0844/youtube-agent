import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { tallyAt } from "./helpers";
import { theme } from "./theme";

export type ProbabilityProps = {
  experiment: "coin" | "dice" | "cards" | "urn";
  title?: string;
  trials: number;
  outcomes: { label: string; count: number; p?: number }[];
  growFrames: number;
};

const NAMES = { coin: "Coin flips", dice: "Dice rolls", cards: "Card draws", urn: "Urn draws" } as const;

export const Probability: React.FC<ProbabilityProps> = ({ experiment, title, trials, outcomes, growFrames }) => {
  const frame = useCurrentFrame();
  const shown = outcomes.map((o) => tallyAt(frame, growFrames, o.count));
  const done = shown.reduce((a, c) => a + c, 0);
  return (
    <AbsoluteFill
      style={{
        background: theme.palette.bg,
        padding: `${theme.safe.top}px ${theme.safe.side}px ${theme.safe.bottom}px`,
        fontFamily: theme.fonts.ui,
        color: theme.palette.text,
        justifyContent: "center",
      }}
    >
      <div style={{ fontSize: 44, color: theme.palette.muted }}>{title ?? NAMES[experiment]}</div>
      <div style={{ fontSize: 40, color: theme.palette.muted, marginBottom: 40 }}>
        {done} of {trials}
      </div>
      {outcomes.map((o, i) => (
        <div key={i} style={{ marginBottom: 32 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 44, marginBottom: 10 }}>
            <span>{o.label}</span>
            <span style={{ fontFamily: theme.fonts.mono }}>
              {shown[i]}
              {o.p !== undefined && <span style={{ color: theme.palette.muted }}> ({Math.round(o.p * 100)}% expected)</span>}
            </span>
          </div>
          <div style={{ height: 36, borderRadius: 18, background: theme.palette.surface, overflow: "hidden" }}>
            <div style={{ width: `${(shown[i] / trials) * 100}%`, height: "100%", background: theme.palette.accent }} />
          </div>
        </div>
      ))}
    </AbsoluteFill>
  );
};
