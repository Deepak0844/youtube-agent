import { z } from "zod";
import { base, copy, LIMITS } from "./common";
import { parseFen, replayMoves, SQUARE_RE, START_FEN } from "../../../../remotion/kit/chessLogic";

const square = z.string().regex(SQUARE_RE, "must be a square like e4 (a-h then 1-8, lowercase)");
const pair = z.object({ from: square, to: square }).refine((m) => m.from !== m.to, { message: "from and to must differ", path: ["to"] });

export const schema = z
  .object({
    ...base,
    kind: z.literal("chess"),
    // Piece placement only (first FEN field). Default: the starting position.
    position: z.string().trim().default(START_FEN),
    moves: z.array(pair).max(LIMITS.chessMoves, `must have at most ${LIMITS.chessMoves} moves`).default([]),
    highlights: z.array(square).max(LIMITS.chessMarks, `must have at most ${LIMITS.chessMarks} squares`).default([]),
    arrows: z.array(pair).max(LIMITS.chessArrows, `must have at most ${LIMITS.chessArrows} arrows`).default([]),
    flip: z.boolean().default(false), // true = black at the bottom
    caption: copy(LIMITS.caption).optional(),
  })
  .superRefine((s, ctx) => {
    const p = parseFen(s.position);
    if (!p.ok) return void ctx.addIssue({ code: "custom", path: ["position"], message: p.error });
    const r = replayMoves(p.board, s.moves);
    if (!r.ok) ctx.addIssue({ code: "custom", path: ["moves", r.index, "from"], message: r.error });
  });

export const describe = `kind "chess": optional position (piece placement only, FEN first field like "${START_FEN}"; default start position), moves[] (max ${LIMITS.chessMoves}) each {from, to} squares like "e2","e4" played in order, optional highlights[] (squares, max ${LIMITS.chessMarks}), arrows[] (max ${LIMITS.chessArrows}) each {from, to}, flip (bool, black at bottom), caption (max ${LIMITS.caption}). Moves are not checked for chess legality, only that a piece stands on "from".`;
