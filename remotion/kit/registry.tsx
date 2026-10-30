import React from "react";
import { Composition } from "remotion";
import { ChatThread, type ChatThreadProps } from "./ChatThread";
import { MathSteps, type MathProps } from "./Math";
import { Probability, type ProbabilityProps } from "./Probability";
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
const math: MathProps = {
  title: "Solve for x",
  steps: [{ text: "2x + 3 = 11" }, { text: "2x = 8", highlight: "8" }, { text: "x = 4", highlight: "4" }],
  framesPerStep: 30,
};
const prob: ProbabilityProps = {
  experiment: "coin",
  trials: 100,
  outcomes: [{ label: "Heads", count: 54, p: 0.5 }, { label: "Tails", count: 46, p: 0.5 }],
  growFrames: 90,
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
  { id: "kit-math", component: MathSteps, defaultProps: math },
  { id: "kit-prob", component: Probability, defaultProps: prob },
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
