// Pure chess helpers (no Remotion imports): strict position parsing and scripted-move replay.
// No rules engine: moves only need a piece on `from`; legality is the author's job.
export const FILES = "abcdefgh";
export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR";
export const SQUARE_RE = /^[a-h][1-8]$/;

export type Piece = "wK" | "wQ" | "wR" | "wB" | "wN" | "wP" | "bK" | "bQ" | "bR" | "bB" | "bN" | "bP";
export type BoardMap = Record<string, Piece>;
export type Move = { from: string; to: string };

/** Column and row (0,0 = top-left square as drawn) of a square. */
export const squareRC = (sq: string, flip = false) => {
  const f = FILES.indexOf(sq[0] ?? "");
  const r = Number(sq[1]) - 1;
  return { col: flip ? 7 - f : f, row: flip ? r : 7 - r };
};

/** Pixel centre of a square on a board whose squares are `s` px wide (top-left of the board is 0,0). */
export const squareCenter = (sq: string, s: number, flip = false) => {
  const { col, row } = squareRC(sq, flip);
  return { x: col * s + s / 2, y: row * s + s / 2 };
};

/** Strict placement-field parser: 8 ranks, digits 1-8 sum to 8, one king each, no pawns on rank 1 or 8. */
export function parseFen(fen: string): { ok: true; board: BoardMap } | { ok: false; error: string } {
  const ranks = fen.split("/");
  if (ranks.length !== 8) return { ok: false, error: "must have 8 ranks separated by '/' (placement only, like the start position)" };
  const board: BoardMap = {};
  const kings = { w: 0, b: 0 };
  for (let i = 0; i < 8; i++) {
    let file = 0;
    for (const ch of ranks[i]!) {
      if (ch >= "1" && ch <= "8") {
        file += Number(ch);
      } else if ("pnbrqkPNBRQK".includes(ch)) {
        if (file > 7) return { ok: false, error: `rank ${8 - i} has more than 8 squares` };
        const colour = ch === ch.toUpperCase() ? "w" : "b";
        if ((ch === "p" || ch === "P") && (i === 0 || i === 7)) return { ok: false, error: "pawns cannot stand on rank 1 or 8" };
        if (ch.toUpperCase() === "K") kings[colour]++;
        board[FILES[file]! + (8 - i)] = (colour + ch.toUpperCase()) as Piece;
        file++;
      } else {
        return { ok: false, error: `unexpected '${ch}' (use pnbrqk, PNBRQK and digits 1-8)` };
      }
    }
    if (file !== 8) return { ok: false, error: `rank ${8 - i} must add up to 8 squares` };
  }
  if (kings.w !== 1 || kings.b !== 1) return { ok: false, error: "needs exactly one white king (K) and one black king (k)" };
  return { ok: true, board };
}

/** Applies moves in order (a piece on `to` is captured). Fails if a `from` square is empty at that point. */
export function replayMoves(start: BoardMap, moves: Move[]): { ok: true; board: BoardMap } | { ok: false; index: number; error: string } {
  const board = { ...start };
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i]!;
    const p = board[m.from];
    if (!p) return { ok: false, index: i, error: `no piece on ${m.from} at this point` };
    delete board[m.from];
    board[m.to] = p;
  }
  return { ok: true, board };
}

export type Sprite = { piece: Piece; col: number; row: number; opacity: number };

const ease = (t: number) => t * t * (3 - 2 * t);

/** Pieces to draw at `frame`: move i slides during [i*framesPerMove, (i+1)*framesPerMove). A captured piece fades as the mover arrives. */
export function spritesAt(start: BoardMap, moves: Move[], frame: number, framesPerMove: number, flip = false): Sprite[] {
  const board = { ...start };
  const flying: Sprite[] = [];
  const fading: Sprite[] = [];
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i]!;
    const t0 = i * framesPerMove;
    if (frame < t0) break;
    const p = board[m.from];
    if (!p) continue;
    const t = framesPerMove <= 0 ? 1 : Math.min(1, (frame - t0) / framesPerMove);
    const victim = board[m.to];
    delete board[m.from];
    if (t >= 1) {
      board[m.to] = p;
    } else {
      const a = squareRC(m.from, flip);
      const b = squareRC(m.to, flip);
      const e = ease(t);
      flying.push({ piece: p, col: a.col + (b.col - a.col) * e, row: a.row + (b.row - a.row) * e, opacity: 1 });
      if (victim) {
        delete board[m.to];
        fading.push({ piece: victim, ...squareRC(m.to, flip), opacity: Math.max(0, 1 - t * 1.5) });
      }
    }
  }
  const still = Object.entries(board).map(([sq, piece]) => ({ piece, ...squareRC(sq, flip), opacity: 1 }));
  return [...still, ...fading, ...flying];
}
