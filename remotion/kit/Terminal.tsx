import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { typedChars } from "./helpers";
import { theme } from "./theme";

export type TerminalProps = {
  lines: { text: string; prompt?: string }[];
  framesPerChar: number;
  /** Pause between the end of one line and the start of the next. */
  gapFrames: number;
};

export const Terminal: React.FC<TerminalProps> = ({ lines, framesPerChar, gapFrames }) => {
  const frame = useCurrentFrame();
  const starts = lines.reduce<number[]>((acc, l, i) => {
    acc.push(i === 0 ? 0 : acc[i - 1] + lines[i - 1].text.length * framesPerChar + gapFrames);
    return acc;
  }, []);
  const rows = lines.map((l, i) => ({
    prompt: l.prompt ?? "$",
    text: l.text.slice(0, typedChars(frame, starts[i], framesPerChar, l.text.length)),
    begun: frame >= starts[i],
  }));
  return (
    <AbsoluteFill
      style={{
        background: theme.palette.bg,
        padding: `${theme.safe.top}px ${theme.safe.side}px ${theme.safe.bottom}px`,
        fontFamily: theme.fonts.mono,
        fontSize: 44,
        color: theme.palette.text,
      }}
    >
      {rows
        .filter((r) => r.begun)
        .map((r, i) => (
          <div key={i} style={{ marginBottom: 20, whiteSpace: "pre-wrap" }}>
            <span style={{ color: theme.palette.accent }}>{r.prompt} </span>
            {r.text}
          </div>
        ))}
    </AbsoluteFill>
  );
};
