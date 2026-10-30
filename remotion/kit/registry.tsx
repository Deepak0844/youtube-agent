import React from "react";
import { Composition } from "remotion";
import { Chart, type ChartProps } from "./Chart";
import { ChatThread, type ChatThreadProps } from "./ChatThread";
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
const sheet: SpreadsheetProps = {
  rows: [["Item", "Qty", "Price"], ["Apple", "3", "1.20"], ["Pear", "5", "0.90"], ["Total", "8", "8.10"]],
  formula: "=SUM(B2:B3)",
  highlight: ["B2:B3", "C4"],
  reveal: "row",
  framesPerStep: 20,
};
const chartBase = { labels: ["Mon", "Tue", "Wed", "Thu"], title: "Views", drawFrames: 60 };
const bar: ChartProps = { ...chartBase, chart: "bar", series: [{ name: "A", values: [3, 5, 8, 6] }, { name: "B", values: [2, 4, 3, 7] }] };
const line: ChartProps = { ...chartBase, chart: "line", series: [{ name: "A", values: [3, 5, 8, 6] }, { name: "B", values: [2, 4, 3, 7] }] };
const pie: ChartProps = { ...chartBase, chart: "pie", series: [{ values: [30, 20, 40, 10] }] };
// A 1x1 transparent-safe data URI keeps the smoke render offline; real jobs pass a staged asset path.
const story: StoryProps = {
  image: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='1080' height='1920'><rect width='100%25' height='100%25' fill='%231e3a5f'/><circle cx='540' cy='960' r='300' fill='%235eead4'/></svg>",
  motion: { zoomFrom: 1, zoomTo: 1.2, panX: 0.03, panY: 0.02 },
};

const common = { width: theme.width, height: theme.height, fps: theme.fps, durationInFrames: 120 };

export const kitCompositions = [
  { id: "kit-terminal", component: Terminal, defaultProps: terminal },
  { id: "kit-chat", component: ChatThread, defaultProps: chat },
  { id: "kit-sheet", component: Spreadsheet, defaultProps: sheet },
  { id: "kit-chart-bar", component: Chart, defaultProps: bar },
  { id: "kit-chart-line", component: Chart, defaultProps: line },
  { id: "kit-chart-pie", component: Chart, defaultProps: pie },
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
