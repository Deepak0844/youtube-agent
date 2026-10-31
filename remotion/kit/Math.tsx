import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { mathReveal } from "./helpers";
import { fitFont, safeSize } from "./layout";
import { theme } from "./theme";

export type MathProps = {
  title?: string;
  steps: { text: string; highlight?: string }[];
  framesPerStep: number;
};

// Plain text only: React escapes everything, nothing is parsed as markup.
const Line: React.FC<{ text: string; highlight?: string }> = ({ text, highlight }) => {
  const at = highlight ? text.indexOf(highlight) : -1;
  if (!highlight || at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <span style={{ color: theme.palette.accent }}>{highlight}</span>
      {text.slice(at + highlight.length)}
    </>
  );
};

export const MathSteps: React.FC<MathProps> = ({ title, steps, framesPerStep }) => {
  const frame = useCurrentFrame();
  const n = mathReveal(frame, framesPerStep, steps.length);
  const safe = safeSize(theme);
  // Pad (56) and gap (28) per step; leave room for the title.
  const size = fitFont(
    steps.map((s) => s.text),
    {
      width: safe.w - 56,
      height: safe.h - (title ? 120 : 0),
      min: theme.type.min,
      max: theme.type.title,
      charW: 0.6,
      lineH: 1.3,
      perItem: 40 + 28,
    },
  );
  return (
    <AbsoluteFill
      style={{
        background: theme.palette.bg,
        padding: `${theme.safe.top}px ${theme.safe.side}px ${theme.safe.bottom}px`,
        fontFamily: theme.fonts.mono,
        color: theme.palette.text,
        justifyContent: "center",
      }}
    >
      {title && (
        <div
          style={{
            fontFamily: theme.fonts.ui,
            fontSize: theme.type.body,
            color: theme.palette.muted,
            marginBottom: 40,
          }}
        >
          {title}
        </div>
      )}
      {steps.slice(0, n).map((s, i) => (
        <div
          key={i}
          style={{
            fontSize: size,
            marginBottom: 28,
            padding: "20px 28px",
            borderRadius: 24,
            background: theme.palette.surface,
            opacity: i === n - 1 ? 1 : 0.7,
            wordBreak: "break-word",
          }}
        >
          <Line text={s.text} highlight={s.highlight} />
        </div>
      ))}
    </AbsoluteFill>
  );
};
