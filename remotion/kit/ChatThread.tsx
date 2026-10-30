import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { visibleCount, windowOpacity } from "./helpers";
import { fitFont, safeSize } from "./layout";
import { ScriptText } from "./ScriptText";
import { theme } from "./theme";

export type ChatThreadProps = {
  messages: { from: "me" | "them"; text: string }[];
  framesPerMessage: number;
  /** Keep only the newest N messages; older ones fade out. Omit to keep all. */
  windowSize?: number;
};

export const ChatThread: React.FC<ChatThreadProps> = ({ messages, framesPerMessage, windowSize }) => {
  const frame = useCurrentFrame();
  const n = visibleCount(frame, framesPerMessage, messages.length);
  const safe = safeSize(theme);
  // Bubbles take 80% of the width minus side padding; each adds padding and a gap.
  const size = fitFont(
    messages.map((m) => m.text),
    {
      width: safe.w * 0.8 - 60,
      height: safe.h - 40,
      min: theme.type.min,
      max: theme.type.big,
      charW: 0.55,
      lineH: 1.3,
      perItem: 44 + 18,
    },
  );
  return (
    <AbsoluteFill
      style={{
        background: theme.palette.bg,
        padding: `${theme.safe.top}px ${theme.safe.side}px ${theme.safe.bottom}px`,
        fontFamily: theme.fonts.ui,
        fontSize: size,
        color: theme.palette.text,
        justifyContent: "center",
      }}
    >
      {messages.map((m, i) => {
        // Unseen messages keep their space (hidden) so the thread stays centred while it grows.
        const opacity = i >= n ? 0 : windowSize ? windowOpacity(frame, framesPerMessage, i, windowSize, 10) : 1;
        return (
          <div
            key={i}
            style={{
              opacity,
              alignSelf: m.from === "me" ? "flex-end" : "flex-start",
              maxWidth: "80%",
              marginTop: 18,
              padding: "22px 30px",
              borderRadius: theme.radii.bubble,
              background: m.from === "me" ? theme.palette.bubbleMe : theme.palette.bubbleThem,
            }}
          >
            <ScriptText text={m.text} />
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
