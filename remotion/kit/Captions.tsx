import React, { useMemo } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { useLook } from "./LookParts";
import { ScriptText } from "./ScriptText";
import { theme } from "./theme";
import { currentWord, paginate, type CaptionWord } from "./timeline";
import { pageWords, type CaptionStyle } from "./presets";

// Rough glyph width; real text measuring needs the DOM, and this only has to be safe, not exact.
const FONT = 68;
const CHAR_W = FONT * 0.58;
const measure = (t: string) => [...t].length * CHAR_W;
const banned = (t: string) => theme.copy.bannedPhrases.some((p) => t.toLowerCase().includes(p));

/** Karaoke captions on a soft dark pill, pinned just under the scene-content area (bottom 22%). Max 2 lines. Estimated words show plain, with no highlight. */
const PillCaptions: React.FC<{ words: CaptionWord[] }> = ({ words }) => {
  const frame = useCurrentFrame();
  const look = useLook();
  const { fps, width, height } = useVideoConfig();
  const maxWidth = Math.min(width - theme.safe.side * 2, theme.copy.maxCharsPerLine * CHAR_W);
  const pages = useMemo(() => paginate(words.map((w) => w.word), maxWidth, measure, 2), [words, maxWidth]);
  const cur = currentWord(words, frame / fps);
  if (cur < 0) return null;
  const page = pages.find((p) => p.some((l) => l.includes(cur)));
  if (!page || banned(page.map((l) => l.map((i) => words[i]!.word).join(" ")).join(" "))) return null;
  return (
    <AbsoluteFill style={{ justifyContent: "flex-start", alignItems: "center", paddingTop: height - theme.safe.bottom + 24, paddingLeft: theme.safe.side, paddingRight: theme.safe.side }}>
      <div style={{ background: "rgba(0,0,0,0.6)", borderRadius: 40, padding: "18px 36px", textAlign: "center", boxShadow: "0 8px 28px rgba(0,0,0,0.35)" }}>
      {page.map((line, li) => (
        <div key={li} style={{ fontSize: FONT, fontWeight: 800, lineHeight: 1.25, color: theme.palette.text, whiteSpace: "pre" }}>
          {line.map((i, k) => {
            const w = words[i]!;
            const on = i === cur && !w.estimated;
            return (
              <span key={i} style={{ color: on ? look.accent : theme.palette.text }}>
                <ScriptText text={w.word} />
                {k < line.length - 1 ? " " : ""}
              </span>
            );
          })}
        </div>
      ))}
      </div>
    </AbsoluteFill>
  );
};

/** Retention captions: a few big words at a time, outlined, active word coloured, no background. */
const PagedCaptions: React.FC<{ words: CaptionWord[]; cs: CaptionStyle }> = ({ words, cs }) => {
  const frame = useCurrentFrame();
  const look = useLook();
  const { fps, height } = useVideoConfig();
  const pages = useMemo(() => pageWords(words, cs.wordsPerPage), [words, cs.wordsPerPage]);
  const cur = currentWord(words, frame / fps);
  if (cur < 0) return null;
  const page = pages.find((p) => p.includes(cur));
  if (!page || banned(page.map((i) => words[i]!.word).join(" "))) return null;
  const active = cs.activeColor === "look" ? look.accent : cs.activeColor;
  return (
    <AbsoluteFill style={{ justifyContent: "flex-start", alignItems: "center", paddingTop: height * cs.topPct, paddingLeft: theme.safe.side, paddingRight: theme.safe.side }}>
      <div style={{ textAlign: "center", fontSize: cs.fontSize, fontWeight: 900, lineHeight: 1.15, WebkitTextStroke: `${cs.outlinePx}px #000`, paintOrder: "stroke fill", textShadow: "0 6px 18px rgba(0,0,0,0.5)" }}>
        {page.map((i, k) => {
          const w = words[i]!;
          return (
            <span key={i} style={{ color: i === cur && !w.estimated ? active : theme.palette.text }}>
              <ScriptText text={w.word} />
              {k < page.length - 1 ? " " : ""}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

/** No style (or the pill) = today's captions, untouched. */
export const Captions: React.FC<{ words: CaptionWord[]; style?: CaptionStyle }> = ({ words, style }) =>
  style?.layout === "paged" ? <PagedCaptions words={words} cs={style} /> : <PillCaptions words={words} />;
