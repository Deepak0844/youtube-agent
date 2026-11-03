import { lookBg } from "./look";
import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Headline, useInk, useLook } from "./LookParts";
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
  const look = useLook();
  const ink = useInk();
  const revealed = frame >= revealAtFrame;
  return (
    <AbsoluteFill
      style={{
        background: lookBg,
        padding: `${theme.safe.top}px ${theme.safe.side}px ${theme.safe.bottom}px`,
        justifyContent: "center",
        gap: 28,
        fontFamily: theme.fonts.ui,
        color: ink.text,
      }}
    >
      <Headline text={question} size={theme.type.hero} style={{ marginBottom: 24 }} />
      {options.map((o, i) => {
        const right = revealed && i === answer;
        return (
          <div
            key={i}
            style={{
              padding: "32px 40px",
              borderRadius: theme.radii.card + 12,
              fontSize: theme.type.big,
              background: right ? look.accent : ink.chip,
              color: right ? ink.bg : ink.text,
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
