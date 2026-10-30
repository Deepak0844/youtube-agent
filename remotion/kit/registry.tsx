import React from "react";
import { Composition } from "remotion";
import { ChatThread, type ChatThreadProps } from "./ChatThread";
import { Collage, type CollageProps } from "./Collage";
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
// A 1x1 transparent-safe data URI keeps the smoke render offline; real jobs pass a staged asset path.
const story: StoryProps = {
  image: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='1080' height='1920'><rect width='100%25' height='100%25' fill='%231e3a5f'/><circle cx='540' cy='960' r='300' fill='%235eead4'/></svg>",
  motion: { zoomFrom: 1, zoomTo: 1.2, panX: 0.03, panY: 0.02 },
};

const swatch = (c: string) => `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='600' height='800'><rect width='100%25' height='100%25' fill='%23${c}'/></svg>`;
const collage = (layout: CollageProps["layout"], n: number): CollageProps => ({
  layout,
  tiles: ["1e3a5f", "5eead4", "7c3aed", "f59e0b", "ef4444", "10b981"].slice(0, n).map((c, i) => ({
    src: swatch(c),
    media: "image" as const,
    enter: (["fade", "pop", "slide_left", "slide_right", "rise", "fade"] as const)[i],
    startFrame: i * 10,
    caption: i % 2 ? undefined : `tile ${i + 1}`,
  })),
});

const common = { width: theme.width, height: theme.height, fps: theme.fps, durationInFrames: 120 };

export const kitCompositions = [
  { id: "kit-terminal", component: Terminal, defaultProps: terminal },
  { id: "kit-chat", component: ChatThread, defaultProps: chat },
  { id: "kit-story", component: Story, defaultProps: story },
  { id: "kit-collage-grid2", component: Collage, defaultProps: collage("grid2", 4) },
  { id: "kit-collage-grid3", component: Collage, defaultProps: collage("grid3", 6) },
  { id: "kit-collage-hero", component: Collage, defaultProps: collage("hero_plus_strip", 4) },
  { id: "kit-collage-stagger", component: Collage, defaultProps: collage("stagger", 5) },
] as const;

export const KitRoot: React.FC = () => (
  <>
    {kitCompositions.map((c) => (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      <Composition key={c.id} id={c.id} component={c.component as React.FC<any>} defaultProps={c.defaultProps} {...common} />
    ))}
  </>
);
