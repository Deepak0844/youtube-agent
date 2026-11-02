// One small valid sample scene per kind, for the /dev/kit page. Picture ids point at nothing, so the kit shows its stand-in picture.
import { SVG_EXAMPLE } from "../../../remotion/kit/svgDiagram";
import type { SceneDoc } from "./schema";

const b = (kind: string) => ({ id: `s-${kind}`.slice(0, 32).replace(/_/g, "-"), beat: "b1", startMs: 0, durationMs: 4000, kind });

export const SAMPLE_SCENES: Record<string, Record<string, unknown>> = {
  algo_cells: { ...b("algo_cells"), title: "Bubble sort", cells: ["5", "2", "8", "1"], steps: [{ at: 500, type: "compare", i: 0, j: 1 }, { at: 1200, type: "swap", i: 0, j: 1 }, { at: 2000, type: "mark_done", i: 3 }] },
  browser: { ...b("browser"), title: "Pricing", url: "example.com/pricing", blocks: [{ type: "heading", text: "Simple pricing" }, { type: "text", text: "Free for small teams." }, { type: "image", asset: "img-demo" }] },
  chart: { ...b("chart"), chart: "bar", title: "Visits", labels: ["Mon", "Tue", "Wed"], series: [{ values: [3, 7, 5] }] },
  chat_thread: { ...b("chat_thread"), messages: [{ from: "user", text: "Did it ship?" }, { from: "assistant", text: "Yes, just now." }] },
  chess: { ...b("chess"), moves: [{ from: "e2", to: "e4" }, { from: "e7", to: "e5" }], highlights: ["e4"], caption: "King pawn opening" },
  collage: { ...b("collage"), layout: "grid2", tiles: [{ asset: "img-a" }, { asset: "img-b" }, { asset: "img-c" }, { asset: "img-d" }] },
  drawn_objects: { ...b("drawn_objects"), objects: [{ object: "laptop", label: "Laptop", slot: "left" }, { object: "cloud", label: "Cloud", slot: "right", enter: "pop" }] },
  map: { ...b("map"), title: "Trip", region: "world", markers: [{ label: "Paris", lat: 48.85, lon: 2.35 }, { label: "Tokyo", lat: 35.68, lon: 139.69 }], route: true },
  math: { ...b("math"), title: "Solve", steps: [{ text: "2x + 3 = 11" }, { text: "2x = 8" }, { text: "x = 4", highlight: "4" }] },
  network: { ...b("network"), nodes: [{ id: "me", type: "laptop", label: "You" }, { id: "dns", type: "resolver", label: "Resolver" }], links: [{ from: "me", to: "dns", packet: "who is?" }] },
  orbit: { ...b("orbit"), title: "Inner planets", preset: "solar_system" },
  pause_card: { ...b("pause_card"), question: "Which is a prime number?", options: ["4", "7", "9"], answer: 1, revealAtMs: 2500 },
  piano: { ...b("piano"), from: "C4", to: "C5", events: [{ atMs: 500, notes: ["C4", "E4", "G4"], label: "C major" }] },
  probability: { ...b("probability"), experiment: "coin", title: "100 flips", trials: 100, outcomes: [{ label: "Heads", count: 52, p: 0.5 }, { label: "Tails", count: 48, p: 0.5 }] },
  spreadsheet: { ...b("spreadsheet"), rows: [["Item", "Cost"], ["Tea", "3"], ["Cake", "5"]], formula: "=SUM(B2:B3)", highlight: ["B2:B3"] },
  stock_clip: { ...b("stock_clip"), asset: "img-demo", caption: "Stock footage" },
  story_kenburns: { ...b("story_kenburns"), image: "img-demo", caption: "A slow zoom" },
  svg_diagram: { ...b("svg_diagram"), title: "Load balancer", svg: SVG_EXAMPLE, steps: [{ at: 0, caption: "One request arrives" }, { at: 0.6, caption: "It goes to a server" }] },
  terminal: { ...b("terminal"), lines: [{ text: "npm run build" }, { text: "build ok", prompt: ">", output: true }] },
};

export const sampleDoc = (kind: string): SceneDoc => ({ version: 1, scenes: [SAMPLE_SCENES[kind]] }) as unknown as SceneDoc;
