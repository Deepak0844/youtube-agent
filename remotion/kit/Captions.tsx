import React, { useMemo } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { ScriptText } from "./ScriptText";
import { theme } from "./theme";
import { currentWord, paginate, type CaptionWord } from "./timeline";

// Rough glyph width; real text measuring needs the DOM, and this only has to be safe, not exact.
const CHAR_W = theme.type.caption * 0.58;
const measure = (t: string) => [...t].length * CHAR_W;
const banned = (t: string) => theme.copy.bannedPhrases.some((p) => t.toLowerCase().includes(p));

/** Karaoke captions in the lower safe zone. Max 2 lines. Estimated words show plain, with no highlight. */
export const Captions: React.FC<{ words: CaptionWord[] }> = ({ words }) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const maxWidth = Math.min(width - theme.safe.side * 2, theme.copy.maxCharsPerLine * CHAR_W);
  const pages = useMemo(() => paginate(words.map((w) => w.word), maxWidth, measure, 2), [words, maxWidth]);
  const cur = currentWord(words, frame / fps);
  if (cur < 0) return null;
  const page = pages.find((p) => p.some((l) => l.includes(cur)));
  if (!page || banned(page.map((l) => l.map((i) => words[i]!.word).join(" ")).join(" "))) return null;
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: theme.safe.bottom, paddingLeft: theme.safe.side, paddingRight: theme.safe.side }}>
      {page.map((line, li) => (
        <div key={li} style={{ fontSize: theme.type.caption, fontWeight: 700, color: theme.palette.text, textShadow: "0 3px 12px rgba(0,0,0,0.8)", whiteSpace: "pre" }}>
          {line.map((i, k) => {
            const w = words[i]!;
            const on = i === cur && !w.estimated;
            return (
              <span key={i} style={{ color: on ? theme.palette.highlight : theme.palette.text }}>
                <ScriptText text={w.word} />
                {k < line.length - 1 ? " " : ""}
              </span>
            );
          })}
        </div>
      ))}
    </AbsoluteFill>
  );
};
