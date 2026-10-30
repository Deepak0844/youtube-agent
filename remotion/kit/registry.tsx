import React from "react";
import { Composition } from "remotion";
import { Browser, type BrowserProps } from "./Browser";
import { ChatThread, type ChatThreadProps } from "./ChatThread";
import { PauseCard, type PauseCardProps } from "./PauseCard";
import { StockClip, type StockClipProps } from "./StockClip";
import { DrawnObjects, type DrawnObjectsProps } from "./DrawnObjects";
import { Network, type NetworkProps } from "./Network";
import { MathSteps, type MathProps } from "./Math";
import { Probability, type ProbabilityProps } from "./Probability";
import { Chart, type ChartProps } from "./Chart";
import { Spreadsheet, type SpreadsheetProps } from "./Spreadsheet";
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
// 5 messages, window of 3: by the last frame the first two have faded out.
const chatWindow: ChatThreadProps = {
  messages: [
    { from: "them", text: "context window?" },
    { from: "me", text: "the last few messages" },
    { from: "them", text: "and older ones?" },
    { from: "me", text: "they slide out" },
    { from: "them", text: "got it" },
  ],
  framesPerMessage: 22,
  windowSize: 3,
};
const browser: BrowserProps = {
  title: "Pricing - Example",
  url: "example.com/pricing",
  blocks: [
    { type: "heading", text: "Simple pricing" },
    { type: "text", text: "Free for small teams, paid when you grow." },
    { type: "image", src: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='600' height='300'><rect width='100%25' height='100%25' fill='%231e3a5f'/></svg>" },
  ],
  framesPerBlock: 30,
const drawn: DrawnObjectsProps = {
  objects: [
    { object: "laptop", label: "dev", enter: "pop" },
    { object: "server_rack", label: "prod", slot: "right", enter: "slide_up", emphasis: "pulse" },
    { object: "jug", slot: "left" },
    { object: "padlock", label: "TLS", emphasis: "wiggle" },
const net: NetworkProps = {
  nodes: [
    { id: "me", type: "laptop", label: "Browser" },
    { id: "dns", type: "resolver", label: "Resolver" },
    { id: "root", type: "root", label: "Root" },
    { id: "tld", type: "tld", label: ".com" },
    { id: "web", type: "rack", label: "Server" },
  links: [
    { from: "me", to: "dns", packet: "A?" },
    { from: "dns", to: "root", packet: ".com?" },
    { from: "root", to: "tld" },
    { from: "tld", to: "web", packet: "IP" },
const math: MathProps = {
  title: "Solve for x",
  steps: [{ text: "2x + 3 = 11" }, { text: "2x = 8", highlight: "8" }, { text: "x = 4", highlight: "4" }],
  framesPerStep: 30,
const prob: ProbabilityProps = {
  experiment: "coin",
  trials: 100,
  outcomes: [{ label: "Heads", count: 54, p: 0.5 }, { label: "Tails", count: 46, p: 0.5 }],
  growFrames: 90,
};
const sheet: SpreadsheetProps = {
  rows: [["Item", "Qty", "Price"], ["Apple", "3", "1.20"], ["Pear", "5", "0.90"], ["Total", "8", "8.10"]],
  formula: "=SUM(B2:B3)",
  highlight: ["B2:B3", "C4"],
  reveal: "row",
  framesPerStep: 20,
const chartBase = { labels: ["Mon", "Tue", "Wed", "Thu"], title: "Views", drawFrames: 60 };
const bar: ChartProps = { ...chartBase, chart: "bar", series: [{ name: "A", values: [3, 5, 8, 6] }, { name: "B", values: [2, 4, 3, 7] }] };
const line: ChartProps = { ...chartBase, chart: "line", series: [{ name: "A", values: [3, 5, 8, 6] }, { name: "B", values: [2, 4, 3, 7] }] };
const pie: ChartProps = { ...chartBase, chart: "pie", series: [{ values: [30, 20, 40, 10] }] };
// A 1x1 transparent-safe data URI keeps the smoke render offline; real jobs pass a staged asset path.
const story: StoryProps = {
  image: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='1080' height='1920'><rect width='100%25' height='100%25' fill='%231e3a5f'/><circle cx='540' cy='960' r='300' fill='%235eead4'/></svg>",
  motion: { zoomFrom: 1, zoomTo: 1.2, panX: 0.03, panY: 0.02 },
};

const pause: PauseCardProps = { question: "Which one is real?", options: ["Left", "Right", "Both"], answer: 1, revealAtFrame: 70 };
const stock: StockClipProps = { src: story.image, media: "image", dim: 0.3, caption: "Stock footage example" };

const common = { width: theme.width, height: theme.height, fps: theme.fps, durationInFrames: 120 };

export const kitCompositions = [
  { id: "kit-terminal", component: Terminal, defaultProps: terminal },
  { id: "kit-chat", component: ChatThread, defaultProps: chat },
  { id: "kit-chat-window", component: ChatThread, defaultProps: chatWindow },
  { id: "kit-browser", component: Browser, defaultProps: browser },
  { id: "kit-drawn", component: DrawnObjects, defaultProps: drawn },
  { id: "kit-network", component: Network, defaultProps: net },
  { id: "kit-math", component: MathSteps, defaultProps: math },
  { id: "kit-prob", component: Probability, defaultProps: prob },
  { id: "kit-sheet", component: Spreadsheet, defaultProps: sheet },
  { id: "kit-chart-bar", component: Chart, defaultProps: bar },
  { id: "kit-chart-line", component: Chart, defaultProps: line },
  { id: "kit-chart-pie", component: Chart, defaultProps: pie },
  { id: "kit-story", component: Story, defaultProps: story },
  { id: "kit-stock", component: StockClip, defaultProps: stock },
  { id: "kit-pause", component: PauseCard, defaultProps: pause },
] as const;

export const KitRoot: React.FC = () => (
  <>
    {kitCompositions.map((c) => (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      <Composition key={c.id} id={c.id} component={c.component as React.FC<any>} defaultProps={c.defaultProps} {...common} />
    ))}
  </>
);
