import React, { useMemo } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { useInk, useLook } from "./LookParts";
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
const PillCaptions: React.FC<{ words: CaptionWord[]; cs?: CaptionStyle }> = ({ words, cs }) => {
  const frame = useCurrentFrame();
  const look = useLook();
  const ink = useInk();
  const { fps } = useVideoConfig();
  const { width, height } = theme; // the 1080x1920 stage, even when a landscape frame hosts it
  const maxWidth = Math.min(width - theme.safe.side * 2, theme.copy.maxCharsPerLine * CHAR_W);
  const pages = useMemo(() => paginate(words.map((w) => w.word), maxWidth, measure, 2), [words, maxWidth]);
  const cur = currentWord(words, frame / fps);
  if (cur < 0) return null;
  const left = cs?.align === "left";
  const active = !cs || cs.activeColor === "look" ? look.accent : cs.activeColor;
  const page = pages.find((p) => p.some((l) => l.includes(cur)));
  if (!page || banned(page.map((l) => l.map((i) => words[i]!.word).join(" ")).join(" "))) return null;
  return (
    <AbsoluteFill style={{ justifyContent: "flex-start", alignItems: left ? "flex-start" : "center", paddingTop: height - theme.safe.bottom + 24, paddingLeft: theme.safe.side, paddingRight: theme.safe.side }}>
      <div style={{ background: cs?.pillBg ?? "rgba(0,0,0,0.6)", borderRadius: 40, padding: cs?.pillBg === "transparent" ? "18px 0" : "18px 36px", textAlign: left ? "left" : "center", boxShadow: cs?.pillBg ? "none" : "0 8px 28px rgba(0,0,0,0.35)" }}>
      {page.map((line, li) => (
        <div key={li} style={{ fontSize: cs?.fontSize ?? FONT, fontWeight: 800, lineHeight: 1.25, color: cs?.textColor ?? ink.text, whiteSpace: "pre", textShadow: cs?.glow ? `0 0 14px ${cs.glow}` : undefined }}>
          {line.map((i, k) => {
            const w = words[i]!;
            const on = i === cur && !w.estimated;
            return (
              <span key={i} style={{ color: on ? active : cs?.textColor ?? ink.text }}>
                <ScriptText text={w.word} font={cs?.font} />
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
  const { fps } = useVideoConfig();
  const { height } = theme;
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
              <ScriptText text={w.word} font={cs.font} />
              {k < page.length - 1 ? " " : ""}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// 0 to 1 progress of a move that starts `start` frames in and lasts `frames`.
const rise = (frame: number, start: number, frames: number) => Math.min(1, Math.max(0, (frame - start) / frames));

/** Paper cutout: one torn paper tag per word, tilted a little differently each time, popping in. */
const TagCaptions: React.FC<{ words: CaptionWord[]; cs: CaptionStyle }> = ({ words, cs }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { height } = theme;
  const cur = currentWord(words, frame / fps);
  if (cur < 0 || banned(words[cur]!.word)) return null;
  const w = words[cur]!;
  const age = frame - Math.round(w.startS * fps);
  const tilt = ((cur * 7) % 9) - 4;
  return (
    <AbsoluteFill style={{ justifyContent: "flex-start", alignItems: "center", paddingTop: height * cs.topPct }}>
      <div style={{ background: cs.activeColor, color: cs.textColor ?? "#fff", padding: "12px 40px", fontSize: cs.fontSize, fontWeight: 900, transform: `rotate(${tilt}deg) scale(${0.7 + 0.3 * rise(age, 0, 6)})`, boxShadow: "0 8px 12px rgba(0,0,0,0.4)", clipPath: "polygon(0 0, 100% 5%, 98% 100%, 3% 95%)" }}>
        <ScriptText text={w.word} font={cs.font} />
      </div>
    </AbsoluteFill>
  );
};

/** Kinetic type: the page's words stacked big in capitals, each rising out of a mask a few frames after the one before. */
const KineticCaptions: React.FC<{ words: CaptionWord[]; cs: CaptionStyle }> = ({ words, cs }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { height } = theme;
  const pages = useMemo(() => pageWords(words, cs.wordsPerPage), [words, cs.wordsPerPage]);
  const cur = currentWord(words, frame / fps);
  if (cur < 0) return null;
  const page = pages.find((p) => p.includes(cur));
  if (!page || banned(page.map((i) => words[i]!.word).join(" "))) return null;
  const pageStart = Math.round(words[page[0]!]!.startS * fps);
  return (
    <AbsoluteFill style={{ justifyContent: "flex-start", alignItems: "flex-start", paddingTop: height * cs.topPct, paddingLeft: theme.safe.side, paddingRight: theme.safe.side }}>
      {page.map((i, k) => {
        const t = rise(frame - pageStart, k * 3, 18);
        const e = 1 - Math.pow(1 - t, 3);
        const hit = i === cur && !words[i]!.estimated;
        return (
          <div key={i} style={{ overflow: "hidden", lineHeight: 1 }}>
            <div style={{ fontSize: cs.fontSize, textTransform: "uppercase", color: hit ? cs.activeColor : theme.palette.text, transform: `translateY(${(1 - e) * 110}%)`, opacity: e }}>
              <ScriptText text={words[i]!.word} font={cs.font} />
            </div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

/** No style (or the plain pill) = today's captions, untouched. */
export const Captions: React.FC<{ words: CaptionWord[]; style?: CaptionStyle }> = ({ words, style }) =>
  style?.layout === "paged" ? <PagedCaptions words={words} cs={style} /> : style?.layout === "tags" ? <TagCaptions words={words} cs={style} /> : style?.layout === "kinetic" ? <KineticCaptions words={words} cs={style} /> : <PillCaptions words={words} cs={style} />;
