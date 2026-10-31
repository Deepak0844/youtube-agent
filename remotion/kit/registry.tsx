import React from "react";
import { AbsoluteFill, Audio, Composition, Sequence, staticFile } from "remotion";
import { Browser, type BrowserProps } from "./Browser";
import { ChatThread, type ChatThreadProps } from "./ChatThread";
import { PauseCard, type PauseCardProps } from "./PauseCard";
import { StockClip, type StockClipProps } from "./StockClip";
import { Story, type StoryProps } from "./Story";
import { Terminal, type TerminalProps } from "./Terminal";
import { theme } from "./theme";
import { DrawnObjects, type DrawnObjectsProps } from "./DrawnObjects";
import { Network, type NetworkProps } from "./Network";
import { MathSteps, type MathProps } from "./Math";
import { Probability, type ProbabilityProps } from "./Probability";
import { Chart, type ChartProps } from "./Chart";
import { Spreadsheet, type SpreadsheetProps } from "./Spreadsheet";
import { AlgoCells, type AlgoCellsProps } from "./AlgoCells";
import { Collage, type CollageProps } from "./Collage";
import { Chess, type ChessProps } from "./Chess";
import { START_FEN, parseFen } from "./chessLogic";
import { Piano, type PianoProps } from "./Piano";
import { MapPiece, type MapProps } from "./MapPiece";
import { Orbit, type OrbitProps } from "./Orbit";
import { Captions } from "./Captions";
import { collageStarts, docFrames, mediaOf, msToFrame, sceneRange, type CaptionWord } from "./timeline";
import type { Scene, SceneDoc } from "../../src/shared/scene";

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
};
// Preview-only stand-in for footage: sky gradient, sun and two hill layers, all derived from one hue.
const sceneArt = (h: number): string => {
  const c = (dh: number, sat: number, l: number) => `hsl(${(h + dh) % 360},${sat}%25,${l}%25)`;
  return `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='1080' height='1920'><defs><linearGradient id='g' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='${c(0, 55, 22)}'/><stop offset='0.6' stop-color='${c(30, 65, 55)}'/></linearGradient></defs><rect width='100%25' height='100%25' fill='url(%23g)'/><circle cx='760' cy='820' r='130' fill='${c(60, 90, 78)}'/><path d='M0 1180 Q300 1020 560 1130 T1080 1060 V1920 H0Z' fill='${c(10, 35, 18)}'/><path d='M0 1420 Q340 1280 640 1390 T1080 1340 V1920 H0Z' fill='${c(-10, 30, 11)}'/></svg>`;
};
// A data URI keeps the smoke render offline; real jobs pass a staged asset path.
const story: StoryProps = {
  image: sceneArt(215),
  motion: { zoomFrom: 1, zoomTo: 1.2, panX: 0.03, panY: 0.02 },
};

const pause: PauseCardProps = { question: "Which one is real?", options: ["Left", "Right", "Both"], answer: 1, revealAtFrame: 70 };
const stock: StockClipProps = { src: story.image, media: "image", dim: 0.3, caption: "Stock footage example" };

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
const algo: AlgoCellsProps = {
  title: "bubble sort",
  cells: ["5", "2", "9", "1", "7", "3"],
  steps: [
    { at: 300, type: "compare", i: 0, j: 1 },
    { at: 1000, type: "swap", i: 0, j: 1 },
    { at: 1600, type: "pointer", i: 3 },
    { at: 2400, type: "mark_done", i: 2 },
  ],
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
const orbit: OrbitProps = { title: "Planets", preset: "solar_system" };
const map: MapProps = {
  title: "Route",
  region: "world",
  markers: [
    { label: "Paris", lat: 48.85, lon: 2.35 },
    { label: "New York", lat: 40.71, lon: -74.0 },
    { label: "Tokyo", lat: 35.68, lon: 139.69 },
  ],
  route: true,
  framesPerMarker: 25,
};
// To make a new scene kind previewable (npm run kit:preview): add a `case` to KitScene below and the kind to rendered.ts.
// Type-only import: the render image has no zod, so nothing from src/ may be imported at runtime here.
const common = { width: theme.width, height: theme.height, fps: theme.fps, durationInFrames: 120 };

export const kitCompositions = [
  { id: "kit-terminal", component: Terminal, defaultProps: terminal },
  { id: "kit-chat", component: ChatThread, defaultProps: chat },
  { id: "kit-chat-window", component: ChatThread, defaultProps: chatWindow },
  { id: "kit-browser", component: Browser, defaultProps: browser },
  { id: "kit-story", component: Story, defaultProps: story },
  { id: "kit-stock", component: StockClip, defaultProps: stock },
  { id: "kit-pause", component: PauseCard, defaultProps: pause },
  { id: "kit-drawn", component: DrawnObjects, defaultProps: drawn },
  { id: "kit-network", component: Network, defaultProps: net },
  { id: "kit-math", component: MathSteps, defaultProps: math },
  { id: "kit-prob", component: Probability, defaultProps: prob },
  { id: "kit-sheet", component: Spreadsheet, defaultProps: sheet },
  { id: "kit-chart-bar", component: Chart, defaultProps: bar },
  { id: "kit-chart-line", component: Chart, defaultProps: line },
  { id: "kit-chart-pie", component: Chart, defaultProps: pie },
  { id: "kit-algo", component: AlgoCells, defaultProps: algo },
  { id: "kit-collage-grid2", component: Collage, defaultProps: collage("grid2", 4) },
  { id: "kit-collage-grid3", component: Collage, defaultProps: collage("grid3", 6) },
  { id: "kit-collage-hero", component: Collage, defaultProps: collage("hero_plus_strip", 4) },
  { id: "kit-collage-stagger", component: Collage, defaultProps: collage("stagger", 5) },
  { id: "kit-chess", component: Chess, defaultProps: chess },
  { id: "kit-piano", component: Piano, defaultProps: piano },
  { id: "kit-orbit", component: Orbit, defaultProps: orbit },
  { id: "kit-map", component: MapPiece, defaultProps: map },
] as const;

// Asset ids resolve to a placeholder colour picture in preview; real jobs stage the real image.
const placeholder = (id: string): string => {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return sceneArt(h);
};

type ResolveAsset = (id: string) => string;
type KitSceneProps = { scene: Scene; resolveAsset?: ResolveAsset; fps?: number };

// One validated scene in, one kit piece out. Terminal "output" lines are not drawn by the pieces yet.
// Every kind in the schema registry needs a case; tests/unit/kit-scene.test.ts checks rendered.ts against it.
export const KitScene: React.FC<KitSceneProps> = ({ scene, resolveAsset = placeholder, fps = theme.fps }) => {
  const f = (ms: number) => msToFrame(ms, fps);
  switch (scene.kind) {
    case "terminal":
      return <Terminal lines={scene.lines} framesPerChar={2} gapFrames={15} />;
    case "chat_thread":
      return <ChatThread messages={scene.messages.map((m) => ({ from: m.from === "user" ? "me" : "them", text: m.text }))} framesPerMessage={30} windowSize={scene.windowSize} />;
    case "story_kenburns":
      return <Story image={resolveAsset(scene.image)} motion={scene} caption={scene.caption} captionZone={scene.captionZone} />;
    case "algo_cells":
      return <AlgoCells title={scene.title} cells={scene.cells} steps={scene.steps} />;
    case "browser":
      return (
        <Browser
          title={scene.title}
          url={scene.url}
          blocks={scene.blocks.map((b) => (b.type === "image" ? { type: "image" as const, src: resolveAsset(b.asset) } : b))}
          framesPerBlock={30}
        />
      );
    case "chart":
      return <Chart chart={scene.chart} title={scene.title} labels={scene.labels} series={scene.series} drawFrames={60} />;
    case "chess": {
      const b = parseFen(scene.position);
      return <Chess board={b.ok ? b.board : {}} moves={scene.moves} highlights={scene.highlights} arrows={scene.arrows} flip={scene.flip} caption={scene.caption} framesPerMove={30} />;
    }
    case "collage": {
      const starts = collageStarts(scene.tiles.map((t) => t.delayMs), fps);
      return (
        <Collage
          layout={scene.layout}
          tiles={scene.tiles.map((t, i) => ({ src: resolveAsset(t.asset), media: t.media, enter: t.enter, startFrame: starts[i]!, caption: t.caption }))}
        />
      );
    }
    case "drawn_objects":
      return <DrawnObjects objects={scene.objects} />;
    case "map":
      return <MapPiece title={scene.title} region={scene.region} markers={scene.markers} route={scene.route} framesPerMarker={25} />;
    case "math":
      return <MathSteps title={scene.title} steps={scene.steps} framesPerStep={30} />;
    case "network":
      return <Network nodes={scene.nodes} links={scene.links} />;
    case "orbit":
      return <Orbit title={scene.title} preset={scene.preset} center={scene.center} bodies={scene.bodies} />;
    case "pause_card":
      return <PauseCard question={scene.question} options={scene.options} answer={scene.answer} revealAtFrame={f(scene.revealAtMs)} />;
    case "piano":
      return <Piano from={scene.from} to={scene.to} events={scene.events.map((e) => ({ at: f(e.atMs), notes: e.notes, label: e.label }))} />;
    case "probability":
      return <Probability experiment={scene.experiment} title={scene.title} trials={scene.trials} outcomes={scene.outcomes} growFrames={90} />;
    case "spreadsheet":
      return <Spreadsheet rows={scene.rows} formula={scene.formula} highlight={scene.highlight} reveal={scene.reveal} framesPerStep={20} />;
    case "stock_clip": {
      const src = resolveAsset(scene.asset);
      return <StockClip src={src} media={mediaOf(src)} dim={scene.dim} caption={scene.caption} captionZone={scene.captionZone} />;
    }
    default: {
      const unhandled: never = scene;
      throw new Error(`KitScene: no case for kind ${(unhandled as { kind: string }).kind}`);
    }
  }
};

// `assets` (JSON-safe, from the render job): asset id -> file path in the public dir. Ids not in it get the placeholder.
export type KitVideoProps = { doc: SceneDoc; resolveAsset?: ResolveAsset; assets?: Record<string, string>; audioSrc?: string; captions?: CaptionWord[]; fps?: number };

const fromStaged = (assets: Record<string, string>): ResolveAsset => (id) => (Object.hasOwn(assets, id) ? staticFile(assets[id]!) : placeholder(id));

// Whole video: scenes on a timeline, optional narration, optional karaoke captions on top.
export const KitVideo: React.FC<KitVideoProps> = ({ doc, assets, resolveAsset = assets ? fromStaged(assets) : placeholder, audioSrc, captions, fps = theme.fps }) => (
  <AbsoluteFill style={{ background: theme.palette.bg }}>
    {doc.scenes.map((scene) => {
      const r = sceneRange(scene, fps);
      return (
        <Sequence key={scene.id} from={r.from} durationInFrames={r.duration}>
          <KitScene scene={scene} resolveAsset={resolveAsset} fps={fps} />
        </Sequence>
      );
    })}
    {audioSrc ? <Audio src={/^(https?:|data:|blob:)/.test(audioSrc) ? audioSrc : staticFile(audioSrc)} /> : null}
    {captions?.length ? <Captions words={captions} /> : null}
  </AbsoluteFill>
);

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
      calculateMetadata={({ props }) => ({ durationInFrames: Math.max(1, msToFrame(props.scene.durationMs, theme.fps)) })}
      width={theme.width}
      height={theme.height}
      fps={theme.fps}
      durationInFrames={120}
    />
    <Composition
      id="kit-video"
      component={KitVideo}
      defaultProps={{ doc: { version: 1, scenes: [{ id: "demo", kind: "terminal", beat: "b1", startMs: 0, durationMs: 4000, lines: [{ text: "npm run kit:video", prompt: "$", output: false }] }] } as unknown as SceneDoc } as KitVideoProps}
      calculateMetadata={({ props }) => ({ durationInFrames: docFrames(props.doc.scenes, props.fps ?? theme.fps), fps: props.fps ?? theme.fps })}
      width={theme.width}
      height={theme.height}
      fps={theme.fps}
      durationInFrames={120}
    />
  </>
);
