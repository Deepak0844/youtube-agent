import { describe, expect, it } from "vitest";
import { validateScenes } from "@/shared/scene";
import { parseFen, replayMoves, squareCenter, START_FEN } from "../../../remotion/kit/chessLogic";
import { noteMidi, pianoKeys } from "../../../remotion/kit/pianoLogic";

const doc = (...scenes: unknown[]) => ({ version: 1, scenes });
const errs = (d: unknown) => {
  const r = validateScenes(d);
  return r.ok ? [] : r.errors;
};
const chess = { id: "c1", beat: "b1", kind: "chess", startMs: 0, durationMs: 6000, moves: [{ from: "e2", to: "e4" }] };
const piano = { id: "p1", beat: "b1", kind: "piano", startMs: 0, durationMs: 6000, events: [{ atMs: 0, notes: ["C4", "E4", "G4"], label: "C major" }] };

describe("chess logic", () => {
  it("parses the start position", () => {
    const b = parseFen(START_FEN);
    expect(b.ok && b.board.e1).toBe("wK");
    expect(b.ok && b.board.d8).toBe("bQ");
  });
  it.each([
    ["too few ranks", "8/8/8"],
    ["rank not 8 wide", "rnbqkbnr/ppppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR"],
    ["bad letter", "xnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR"],
    ["pawn on rank 1", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNP"],
    ["no kings", "8/8/8/8/8/8/8/8"],
    ["two white kings", "k7/8/8/8/8/8/8/KK6"],
    ["with extra fields", START_FEN + " w KQkq - 0 1"],
  ])("rejects %s", (_n, fen) => {
    expect(parseFen(fen).ok).toBe(false);
  });
  it("replays a capture and rejects an empty from square", () => {
    const b = parseFen("4k3/8/8/3p4/4P3/8/8/4K3");
    if (!b.ok) throw new Error("fen");
    const r = replayMoves(b.board, [{ from: "e4", to: "d5" }]);
    expect(r.ok && r.board.d5).toBe("wP");
    expect(r.ok && r.board.e4).toBeUndefined();
    expect(replayMoves(b.board, [{ from: "a1", to: "a2" }]).ok).toBe(false);
  });
});

describe("piano logic", () => {
  it("converts note names", () => {
    expect(noteMidi("C4")).toBe(60);
    expect(noteMidi("A#3")).toBe(58);
    expect(noteMidi("H4")).toBeNull();
    expect(noteMidi("Bb4")).toBeNull();
    expect(noteMidi("C9")).toBeNull();
  });
  it("lists keys in range", () => {
    expect(pianoKeys("C4", "B4").length).toBe(12);
  });
});

describe("chess scene", () => {
  it("accepts defaults", () => {
    const r = validateScenes(doc(chess));
    expect(r.ok).toBe(true);
    if (r.ok && r.doc.scenes[0]?.kind === "chess") expect(r.doc.scenes[0].position).toBe(START_FEN);
  });
  it("rejects bad squares, fen, moves and long caption", () => {
    expect(errs(doc({ ...chess, moves: [{ from: "i2", to: "e4" }] }))[0]).toContain("moves > 0 > from: must be a square like e4");
    expect(errs(doc({ ...chess, moves: [{ from: "e2", to: "e9" }] }))[0]).toContain("moves > 0 > to");
    expect(errs(doc({ ...chess, position: "8/8" }))[0]).toContain("position:");
    expect(errs(doc({ ...chess, moves: [{ from: "e4", to: "e5" }] }))[0]).toContain("no piece on e4");
    expect(errs(doc({ ...chess, moves: [{ from: "e2", to: "e2" }] }))[0]).toContain("must differ");
    expect(errs(doc({ ...chess, caption: "x".repeat(81) }))[0]).toContain("caption: must be at most 80");
    expect(errs(doc({ ...chess, moves: Array.from({ length: 9 }, () => ({ from: "e2", to: "e4" })) })).length).toBe(1);
    expect(errs(doc({ ...chess, highlights: ["a1", "z9"] }))[0]).toContain("highlights > 1");
    expect(errs(doc({ ...chess, arrows: [{ from: "a1", to: "a1" }] }))[0]).toContain("must differ");
  });
  it("accepts highlights and arrows", () => {
    expect(errs(doc({ ...chess, highlights: ["e4"], arrows: [{ from: "e2", to: "e4" }], flip: true }))).toEqual([]);
  });
});

describe("piano scene", () => {
  it("accepts defaults", () => {
    expect(errs(doc(piano))).toEqual([]);
  });
  it("rejects bad notes, range and events", () => {
    expect(errs(doc({ ...piano, events: [{ atMs: 0, notes: ["H4"] }] }))[0]).toContain("events > 0 > notes > 0: must be a note like C4 or F#3");
    expect(errs(doc({ ...piano, events: [{ atMs: 0, notes: ["C6"] }] }))[0]).toContain("outside the keyboard");
    expect(errs(doc({ ...piano, from: "C1", to: "C6" }))[0]).toContain("at most");
    expect(errs(doc({ ...piano, from: "C5", to: "C4" }))[0]).toContain("higher than from");
    expect(errs(doc({ ...piano, events: [{ atMs: 0, notes: [] }] })).length).toBe(1);
    expect(errs(doc({ ...piano, events: [{ atMs: 0, notes: ["C4"], label: "x".repeat(25) }] }))[0]).toContain("label");
    expect(errs(doc({ ...piano, events: [{ atMs: 3000, notes: ["C4"] }, { atMs: 1000, notes: ["D4"] }] }))[0]).toContain("in time order");
    expect(errs(doc({ ...piano, events: [{ atMs: 0, notes: ["C4", "D4", "E4", "F4", "G4", "A4", "B4"] }] })).length).toBe(1);
  });
});

describe("squareCenter", () => {
  it("maps squares to pixel centres, flipped or not", () => {
    expect(squareCenter("a1", 100)).toEqual({ x: 50, y: 750 });
    expect(squareCenter("h8", 100)).toEqual({ x: 750, y: 50 });
    expect(squareCenter("a1", 100, true)).toEqual({ x: 750, y: 50 });
  });
});
