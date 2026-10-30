import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { visibleCount } from "./helpers";
import { theme } from "./theme";

export type ChatThreadProps = {
  messages: { from: "me" | "them"; text: string }[];
  framesPerMessage: number;
};

export const ChatThread: React.FC<ChatThreadProps> = ({ messages, framesPerMessage }) => {
  const frame = useCurrentFrame();
  const n = visibleCount(frame, framesPerMessage, messages.length);
  return (
    <AbsoluteFill
      style={{
        background: theme.palette.bg,
        padding: `${theme.safe.top}px ${theme.safe.side}px ${theme.safe.bottom}px`,
        fontFamily: theme.fonts.ui,
        fontSize: 46,
        color: theme.palette.text,
        justifyContent: "flex-end",
      }}
    >
      {messages.slice(0, n).map((m, i) => (
        <div
          key={i}
          style={{
            alignSelf: m.from === "me" ? "flex-end" : "flex-start",
            maxWidth: "80%",
            marginTop: 18,
            padding: "22px 30px",
            borderRadius: 36,
            background: m.from === "me" ? theme.palette.bubbleMe : theme.palette.bubbleThem,
          }}
        >
          {m.text}
        </div>
      ))}
    </AbsoluteFill>
  );
};
