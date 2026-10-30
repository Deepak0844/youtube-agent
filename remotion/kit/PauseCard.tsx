import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { theme } from "./theme";

export type PauseCardProps = {
  question: string;
  options: string[];
  answer: number;
  /** Frame (from scene start) at which the right option is highlighted. */
  revealAtFrame: number;
};

export const PauseCard: React.FC<PauseCardProps> = ({ question, options, answer, revealAtFrame }) => {
  const frame = useCurrentFrame();
  const revealed = frame >= revealAtFrame;
  return (
    <AbsoluteFill
      style={{
        background: theme.palette.bg,
        padding: `${theme.safe.top}px ${theme.safe.side}px ${theme.safe.bottom}px`,
        justifyContent: "center",
        gap: 28,
        fontFamily: theme.fonts.ui,
        color: theme.palette.text,
      }}
    >
      <div style={{ fontSize: 68, fontWeight: 700, marginBottom: 24 }}>{question}</div>
      {options.map((o, i) => {
        const right = revealed && i === answer;
        return (
          <div
            key={i}
            style={{
              padding: "28px 36px",
              borderRadius: 28,
              fontSize: 48,
              background: right ? theme.palette.accent : theme.palette.surface,
              color: right ? theme.palette.bg : theme.palette.text,
              opacity: revealed && !right ? 0.4 : 1,
            }}
          >
            {String.fromCharCode(65 + i)}. {o}
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
