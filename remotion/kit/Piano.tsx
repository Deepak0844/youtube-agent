// Piano keyboard that lights notes/chords on a schedule. Pure drawn rectangles, no assets or third-party art.
import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { noteMidi, pianoKeys } from "./pianoLogic";
import { safeSize } from "./layout";
import { theme } from "./theme";

export type PianoProps = {
  from: string;
  to: string;
  /** `at` is the frame the notes light; they stay lit until the next event. */
  events: { at: number; notes: string[]; label?: string }[];
};

export const Piano: React.FC<PianoProps> = ({ from, to, events }) => {
  const frame = useCurrentFrame();
  const keys = pianoKeys(from, to);
  const whites = keys.filter((k) => !k.black);
  const w = theme.width - 2 * theme.safe.side;
  const kw = w / Math.max(1, whites.length);
  const bw = kw * 0.62;
  // Keyboard: 40% of the safe height, centred at the lower-middle third; label sits above it.
  const safe = safeSize(theme);
  const h = Math.round(safe.h * 0.4);
  const top = Math.round(theme.safe.top + safe.h * 0.55 - h / 2);
  const current = [...events].reverse().find((e) => frame >= e.at);
  const glow = current ? Math.min(1, (frame - current.at) / 6) : 0;
  const lit = new Set((current?.notes ?? []).map((n) => noteMidi(n)));
  return (
    <AbsoluteFill style={{ background: theme.palette.bg, fontFamily: theme.fonts.ui }}>
      <div
        style={{
          position: "absolute",
          left: theme.safe.side,
          right: theme.safe.side,
          top: top - 200,
          textAlign: "center",
          fontSize: theme.type.title + 16,
          fontWeight: 700,
          color: theme.palette.accent,
          opacity: glow,
        }}
      >
        {current?.label ?? ""}
      </div>
      <div
        style={{
          position: "absolute",
          left: theme.safe.side,
          top,
          width: w,
          height: h,
        }}
      >
        {whites.map((k) => (
          <div
            key={k.midi}
            style={{
              position: "absolute",
              left: k.whiteIndex * kw,
              top: 0,
              width: kw - 2,
              height: h,
              borderRadius: "4px 4px 10px 10px",
              background: lit.has(k.midi) ? theme.palette.accent : theme.palette.text,
              opacity: lit.has(k.midi) ? 0.4 + 0.6 * glow : 1,
            }}
          />
        ))}
        {keys
          .filter((k) => k.black)
          .map((k) => (
            <div
              key={k.midi}
              style={{
                position: "absolute",
                left: (k.whiteIndex + 1) * kw - bw / 2 - 1,
                top: 0,
                width: bw,
                height: h * 0.62,
                borderRadius: "2px 2px 6px 6px",
                background: lit.has(k.midi) ? theme.palette.accent : theme.palette.pieceDark,
                border: `2px solid ${theme.palette.surface}`,
                opacity: lit.has(k.midi) ? 0.5 + 0.5 * glow : 1,
              }}
            />
          ))}
      </div>
    </AbsoluteFill>
  );
};
