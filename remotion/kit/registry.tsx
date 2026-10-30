import React from "react";
import { Composition } from "remotion";
import { Chess, type ChessProps } from "./Chess";
import { START_FEN, parseFen } from "./chessLogic";
import { Piano, type PianoProps } from "./Piano";
import { ChatThread, type ChatThreadProps } from "./ChatThread";
import { Story, type StoryProps } from "./Story";
import { Terminal, type TerminalProps } from "./Terminal";
import { theme } from "./theme";

const terminal: TerminalProps = {
  lines: [{ text: "npm run build" }, { text: "build ok", prompt: ">" }],
  framesPerChar: 2,
  gapFrames: 15,
};
const chat: ChatThreadProps = {
  messages: [
    { from: "them", text: "did it ship?" },
    { from: "me", text: "yes, just now" },
    { from: "them", text: "nice" },
  ],
  framesPerMessage: 30,
};
const startBoard = parseFen(START_FEN);
const chess: ChessProps = {
  board: startBoard.ok ? startBoard.board : {},
  moves: [{ from: "e2", to: "e4" }, { from: "e7", to: "e5" }, { from: "g1", to: "f3" }],
  highlights: ["e4"],
  arrows: [{ from: "g1", to: "f3" }],
  flip: false,
  caption: "Open with e4",
  framesPerMove: 30,
};
const piano: PianoProps = {
  from: "C3",
  to: "C5",
  events: [
    { at: 0, notes: ["C4", "E4", "G4"], label: "C major" },
    { at: 60, notes: ["F3", "A3", "C4"], label: "F major" },
    { at: 90, notes: ["G3", "B3", "D4", "F#4"] },
  ],
};
// A 1x1 transparent-safe data URI keeps the smoke render offline; real jobs pass a staged asset path.
const story: StoryProps = {
  image: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='1080' height='1920'><rect width='100%25' height='100%25' fill='%231e3a5f'/><circle cx='540' cy='960' r='300' fill='%235eead4'/></svg>",
  motion: { zoomFrom: 1, zoomTo: 1.2, panX: 0.03, panY: 0.02 },
};

const common = { width: theme.width, height: theme.height, fps: theme.fps, durationInFrames: 120 };

export const kitCompositions = [
  { id: "kit-terminal", component: Terminal, defaultProps: terminal },
  { id: "kit-chat", component: ChatThread, defaultProps: chat },
  { id: "kit-chess", component: Chess, defaultProps: chess },
  { id: "kit-piano", component: Piano, defaultProps: piano },
  { id: "kit-story", component: Story, defaultProps: story },
] as const;

export const KitRoot: React.FC = () => (
  <>
    {kitCompositions.map((c) => (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      <Composition key={c.id} id={c.id} component={c.component as React.FC<any>} defaultProps={c.defaultProps} {...common} />
    ))}
  </>
);
