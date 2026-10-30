// Chess board with scripted moves. Piece art: ORIGINAL flat glyphs drawn for this project (simple polygons below),
// no third-party art. The old kit used the cburnett set (GPL/BSD/GFDL tri-licence), which is not CC0/MIT/CC-BY, so it was NOT copied.
import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { FILES, spritesAt, squareRC, type BoardMap, type Move, type Piece } from "./chessLogic";
import { theme } from "./theme";

export type ChessProps = {
  board: BoardMap;
  moves: Move[];
  highlights: string[];
  arrows: Move[];
  flip: boolean;
  caption?: string;
  framesPerMove: number;
};

const BASE = <rect x="26" y="80" width="48" height="9" rx="3" />;
// Each glyph is drawn in a 100x100 box, fill and stroke set by the wrapper.
const GLYPH: Record<string, React.ReactNode> = {
  P: (
    <>
      <circle cx="50" cy="32" r="13" />
      <path d="M36 80 Q38 54 50 47 Q62 54 64 80 Z" />
      {BASE}
    </>
  ),
  R: (
    <>
      <path d="M32 80 L36 42 L30 42 L30 20 L41 20 L41 29 L46 29 L46 20 L54 20 L54 29 L59 29 L59 20 L70 20 L70 42 L64 42 L68 80 Z" />
      {BASE}
    </>
  ),
  N: (
    <>
      <path d="M30 80 C30 60 38 50 48 42 L38 38 L42 25 L53 16 C70 22 76 42 70 80 Z" />
      <circle cx="53" cy="29" r="2.5" className="eye" />
      {BASE}
    </>
  ),
  B: (
    <>
      <circle cx="50" cy="16" r="6" />
      <ellipse cx="50" cy="38" rx="13" ry="18" />
      <path d="M38 80 Q40 58 50 54 Q60 58 62 80 Z" />
      {BASE}
    </>
  ),
  Q: (
    <>
      <path d="M31 80 L25 32 L40 52 L50 24 L60 52 L75 32 L69 80 Z" />
      <circle cx="25" cy="30" r="5" />
      <circle cx="50" cy="21" r="5" />
      <circle cx="75" cy="30" r="5" />
      {BASE}
    </>
  ),
  K: (
    <>
      <rect x="46" y="10" width="8" height="24" rx="2" />
      <rect x="38" y="17" width="24" height="8" rx="2" />
      <path d="M32 80 C26 56 36 42 50 38 C64 42 74 56 68 80 Z" />
      {BASE}
    </>
  ),
};

export const PieceGlyph: React.FC<{ piece: Piece; size: number }> = ({ piece, size }) => {
  const white = piece[0] === "w";
  const fill = white ? theme.palette.pieceLight : theme.palette.pieceDark;
  const stroke = white ? theme.palette.pieceDark : theme.palette.pieceLight;
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill={fill} stroke={stroke} strokeWidth={3.5} strokeLinejoin="round">
      {GLYPH[piece[1]!]}
    </svg>
  );
};

export const Chess: React.FC<ChessProps> = ({ board, moves, highlights, arrows, flip, caption, framesPerMove }) => {
  const frame = useCurrentFrame();
  const size = theme.width - 2 * theme.safe.side;
  const s = size / 8;
  const top = theme.safe.top + 120;
  const center = (sq: string) => {
    const { col, row } = squareRC(sq, flip);
    return { x: col * s + s / 2, y: row * s + s / 2 };
  };
  const appear = Math.min(1, frame / 10);
  return (
    <AbsoluteFill style={{ background: theme.palette.bg, fontFamily: theme.fonts.mono }}>
      <div style={{ position: "absolute", left: theme.safe.side, top, width: size, height: size, overflow: "hidden", borderRadius: 16 }}>
        {Array.from({ length: 64 }, (_, i) => {
          const col = i % 8;
          const row = Math.floor(i / 8);
          const rank = flip ? row + 1 : 8 - row;
          const file = FILES[flip ? 7 - col : col];
          const bg = (col + row) % 2 ? theme.palette.boardDark : theme.palette.boardLight;
          const label = (col + row) % 2 ? theme.palette.boardLight : theme.palette.boardDark;
          return (
            <div key={i} style={{ position: "absolute", left: col * s, top: row * s, width: s, height: s, background: bg, fontSize: 20, fontWeight: 700, color: label }}>
              {col === 0 && <span style={{ position: "absolute", left: 6, top: 4 }}>{rank}</span>}
              {row === 7 && <span style={{ position: "absolute", right: 6, bottom: 2 }}>{file}</span>}
            </div>
          );
        })}
        {highlights.map((sq) => {
          const { col, row } = squareRC(sq, flip);
          return (
            <div
              key={sq}
              style={{ position: "absolute", left: col * s + 4, top: row * s + 4, width: s - 8, height: s - 8, borderRadius: 10, border: `6px solid ${theme.palette.accent}`, background: `${theme.palette.accent}44`, opacity: appear }}
            />
          );
        })}
        {spritesAt(board, moves, frame, framesPerMove, flip).map((sp, i) => (
          <div key={`${sp.piece}${i}`} style={{ position: "absolute", left: sp.col * s + s * 0.06, top: sp.row * s + s * 0.06, opacity: sp.opacity }}>
            <PieceGlyph piece={sp.piece} size={s * 0.88} />
          </div>
        ))}
        <svg width={size} height={size} style={{ position: "absolute", left: 0, top: 0 }} opacity={appear * 0.9}>
          {arrows.map((a, i) => {
            const c1 = center(a.from);
            const c2 = center(a.to);
            const len = Math.hypot(c2.x - c1.x, c2.y - c1.y) || 1;
            const ux = (c2.x - c1.x) / len;
            const uy = (c2.y - c1.y) / len;
            const hl = s * 0.36;
            const ex = c2.x - ux * s * 0.2;
            const ey = c2.y - uy * s * 0.2;
            const bx = ex - ux * hl;
            const by = ey - uy * hl;
            return (
              <g key={i}>
                <line x1={c1.x + ux * s * 0.25} y1={c1.y + uy * s * 0.25} x2={bx} y2={by} stroke={theme.palette.accent} strokeWidth={s * 0.16} strokeLinecap="round" />
                <polygon points={`${ex},${ey} ${bx - uy * s * 0.2},${by + ux * s * 0.2} ${bx + uy * s * 0.2},${by - ux * s * 0.2}`} fill={theme.palette.accent} />
              </g>
            );
          })}
        </svg>
      </div>
      {caption && (
        <div style={{ position: "absolute", left: theme.safe.side, right: theme.safe.side, top: top + size + 56, fontFamily: theme.fonts.ui, fontSize: 52, fontWeight: 700, color: theme.palette.text, textAlign: "center" }}>
          {caption}
        </div>
      )}
    </AbsoluteFill>
  );
};
