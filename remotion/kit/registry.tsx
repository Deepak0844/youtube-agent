// To make a new scene kind previewable (npm run kit:preview): add one `case "<kind>":` line to KitScene below.
// Type-only import: the render image has no zod, so nothing from src/ may be imported at runtime here.
import React from "react";
import { Composition } from "remotion";
import type { Scene } from "../../src/shared/scene";
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
// A 1x1 transparent-safe data URI keeps the smoke render offline; real jobs pass a staged asset path.
const story: StoryProps = {
  image: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='1080' height='1920'><rect width='100%25' height='100%25' fill='%231e3a5f'/><circle cx='540' cy='960' r='300' fill='%235eead4'/></svg>",
  motion: { zoomFrom: 1, zoomTo: 1.2, panX: 0.03, panY: 0.02 },
};

// Asset ids resolve to a placeholder colour picture in preview; real jobs stage the real image.
const placeholder = (id: string): string => {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='1080' height='1920'><rect width='100%25' height='100%25' fill='hsl(${h},45%25,30%25)'/><circle cx='540' cy='960' r='300' fill='hsl(${(h + 40) % 360},70%25,60%25)'/></svg>`;
};

// One validated scene in, one kit piece out. Captions and terminal "output" lines are not drawn by the pieces yet.
export const KitScene: React.FC<{ scene: Scene }> = ({ scene }) => {
  switch (scene.kind) {
    case "terminal":
      return <Terminal lines={scene.lines} framesPerChar={2} gapFrames={15} />;
    case "chat_thread":
      return <ChatThread messages={scene.messages.map((m) => ({ from: m.from === "user" ? "me" : "them", text: m.text }))} framesPerMessage={30} />;
    case "story_kenburns":
      return <Story image={placeholder(scene.image)} motion={scene} />;
    default:
      return null;
  }
};

const common = { width: theme.width, height: theme.height, fps: theme.fps, durationInFrames: 120 };

export const kitCompositions = [
  { id: "kit-terminal", component: Terminal, defaultProps: terminal },
  { id: "kit-chat", component: ChatThread, defaultProps: chat },
  { id: "kit-story", component: Story, defaultProps: story },
] as const;

export const KitRoot: React.FC = () => (
  <>
    {kitCompositions.map((c) => (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      <Composition key={c.id} id={c.id} component={c.component as React.FC<any>} defaultProps={c.defaultProps} {...common} />
    ))}
    <Composition
      id="kit-scene"
      component={KitScene}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      defaultProps={{ scene: { id: "demo", kind: "terminal", beat: "b1", startMs: 0, durationMs: 4000, lines: [{ text: "npm run kit:studio", prompt: "$", output: false }] } as any }}
      calculateMetadata={({ props }) => ({ durationInFrames: Math.max(1, Math.round((props.scene.durationMs * theme.fps) / 1000)) })}
      width={theme.width}
      height={theme.height}
      fps={theme.fps}
      durationInFrames={120}
    />
  </>
);
