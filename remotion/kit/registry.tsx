import React from "react";
import { Composition } from "remotion";
import { ChatThread, type ChatThreadProps } from "./ChatThread";
import { DrawnObjects, type DrawnObjectsProps } from "./DrawnObjects";
import { Network, type NetworkProps } from "./Network";
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
const drawn: DrawnObjectsProps = {
  objects: [
    { object: "laptop", label: "dev", enter: "pop" },
    { object: "server_rack", label: "prod", slot: "right", enter: "slide_up", emphasis: "pulse" },
    { object: "jug", slot: "left" },
    { object: "padlock", label: "TLS", emphasis: "wiggle" },
  ],
};
const net: NetworkProps = {
  nodes: [
    { id: "me", type: "laptop", label: "Browser" },
    { id: "dns", type: "resolver", label: "Resolver" },
    { id: "root", type: "root", label: "Root" },
    { id: "tld", type: "tld", label: ".com" },
    { id: "web", type: "rack", label: "Server" },
  ],
  links: [
    { from: "me", to: "dns", packet: "A?" },
    { from: "dns", to: "root", packet: ".com?" },
    { from: "root", to: "tld" },
    { from: "tld", to: "web", packet: "IP" },
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
  { id: "kit-drawn", component: DrawnObjects, defaultProps: drawn },
  { id: "kit-network", component: Network, defaultProps: net },
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
