// Types of the "yt-kit" import for model-written scenes. THIS FILE IS THE LIST OF EXPORTS: the type-check worker resolves
// "yt-kit" to it, checkTsx allows exactly these names, and the prompt documents them from the one-line comments below
// (src/server/core/tsx-kit.ts). Keep it in step with ./index.ts (a unit test fails when the two differ).
// Rules for editing: one `export const`/`export function` per name, props written inline as a type literal, ONE short
// comment line above each. Optional frame numbers are in frames (30 per second); x/y are pixels on the 1080x1920 canvas.
import type { FC, ReactNode } from "react";

export type CaptionWord = { w: string; at: number };
export type StackBlock = { label: string; color: string; h?: number };

/** Persistent 1080x1920 svg surface: put every drawn prop (Bulb, Gear, Wire, Laptop...) inside it. */
export const Canvas: FC<{ children?: ReactNode }>;
/** Full-screen dark stage with slow glows; the glows loop exactly so the last frame equals frame 0. */
export const Backdrop: FC<{ base?: string; glow?: string }>;
/** Hook headline, up to 3 lines each with its own colour, plus optional subtitle; fully drawn on every frame (opacity 0..1). */
export const BigTitle: FC<{ lines: readonly { text: string; color?: string }[]; subtitle?: string; y?: number; size?: number; opacity?: number }>;
/** Small label pill, top centre; fades in at frame at and out ending at frame until. */
export const Kicker: FC<{ text: string; color?: string; y?: number; at?: number; until?: number }>;
/** Thin progress bar along the top edge over the whole video. */
export const ProgressBar: FC<{ color?: string }>;
/** Karaoke captions from word start frames (the pipeline already adds captions: use only when the task asks). */
export const Captions: FC<{ words: readonly CaptionWord[]; y?: number; size?: number; accent?: string; maxWords?: number }>;
/** Outlined word pill centred on x,y; pops in at frame at, optionally out by frame until. */
export const Chip: FC<{ text: string; x: number; y: number; color?: string; size?: number; at?: number; until?: number }>;
/** Card with a coloured edge (small label over a line of text); x,y is its top-left corner. */
export const Callout: FC<{ label?: string; text: string; x: number; y: number; w?: number; color?: string; at?: number; until?: number }>;
/** Big number centred on x,y that counts from..to between frames start..end, with optional prefix and suffix text. */
export const Counter: FC<{ from: number; to: number; start: number; end: number; x: number; y: number; size?: number; color?: string; prefix?: string; suffix?: string; mono?: boolean }>;

/** Toothed wheel; rot in degrees (same look after 360/teeth). */
export const Gear: FC<{ x: number; y: number; r?: number; teeth?: number; rot?: number; color?: string; opacity?: number }>;
/** Battery centred on x,y; level 0..1 is the charge. */
export const Battery: FC<{ x: number; y: number; w?: number; level?: number; color?: string; opacity?: number }>;
/** Cable with n dots moving along the points pts; advance phase every frame (frame * 0.012). */
export const Wire: FC<{ pts: readonly (readonly [number, number])[]; phase: number; color?: string; width?: number; n?: number; opacity?: number; dot?: number }>;
/** Bar magnet (red N, blue S) centred on x,y; rot in degrees. */
export const Magnet: FC<{ x: number; y: number; w?: number; rot?: number; opacity?: number }>;
/** Arrow from x1,y1 to x2,y2; grow 0..1 draws it from tail to head. */
export const Arrow: FC<{ x1: number; y1: number; x2: number; y2: number; color?: string; width?: number; grow?: number; opacity?: number }>;

/** Laptop with code on screen; state "ok" tints green, "err" red. x,y = centre, w = width. */
export const Laptop: FC<{ x: number; y: number; w?: number; opacity?: number; state?: "code" | "ok" | "err" }>;
/** Five-unit server rack with blinking lights; err makes them red. */
export const ServerRack: FC<{ x: number; y: number; w?: number; opacity?: number; err?: boolean }>;
/** Shipping container in any colour with an optional label and sub line. */
export const Container: FC<{ x: number; y: number; w?: number; opacity?: number; color?: string; label?: string; sub?: string }>;
/** Cargo ship loaded with containers. */
export const CargoShip: FC<{ x: number; y: number; w?: number; opacity?: number }>;
/** Flat cloud. */
export const Cloud: FC<{ x: number; y: number; w?: number; opacity?: number }>;
/** Round check (ok) or cross (err) badge of radius r that draws its glyph from frame at. */
export const StatusBadge: FC<{ kind: "ok" | "err"; x: number; y: number; r?: number; at?: number; opacity?: number }>;
/** Labelled blocks listed bottom to top that rise one after another from frame at; x,y = centre of the bottom edge. */
export const LayerStack: FC<{ blocks: readonly StackBlock[]; x: number; y: number; w?: number; at?: number; stagger?: number; opacity?: number }>;

/** Light bulb with halo and rays at cx,cy; glow 0..1; about 330 tall at s=1 (halo wider). */
export const Bulb: FC<{ cx: number; cy: number; s?: number; glow?: number }>;
/** Generator front view, radius r, blades turned by rot degrees (8 blades: symmetric every 45); glow and blur 0..1. */
export const Generator: FC<{ cx: number; cy: number; r: number; rot: number; glow?: number; blur?: number }>;
/** Magnets, spinning wire loop and gauge, about 960x760: ang loop degrees, flow phase, flowOn/fieldOn/needle 0..1 (needle -1..1). */
export const MagnetCoil: FC<{ cx: number; cy: number; ang: number; flow: number; flowOn: number; needle: number; fieldOn: number }>;
/** Boiler with flames and steam, w wide; t = frame; fire 0..1. */
export const Boiler: FC<{ cx: number; cy: number; w: number; t: number; fire?: number }>;
/** Wind turbine with tower height h standing at x,baseY; 3 blades turned by rot degrees (symmetric every 120). */
export const WindTurbine: FC<{ x: number; baseY: number; h: number; rot: number }>;
/** Dam with waterfall and water wheel (about 340x330 from x,y); t = frame; wheel rot degrees (symmetric every 45). */
export const Dam: FC<{ x: number; y: number; t: number; rot: number }>;
/** Solar panel with sun, w wide: lit 0..1 lights the cells, beams 0..1 the sunbeams, flow phase, t = frame. */
export const SolarPanel: FC<{ cx: number; cy: number; w: number; lit: number; beams: number; flow: number; t: number }>;
/** Transmission pylon of height h standing at x,baseY. */
export const Pylon: FC<{ x: number; baseY: number; h: number }>;
/** Percentage ring: pct 0..1 is the filled part, label is the centre text (short). */
export const Donut: FC<{ cx: number; cy: number; r: number; pct: number; label: string }>;

/** 0..1 progress of t through frames a..b, clamped. */
export function prog(t: number, a: number, b: number): number;
/** Linear mix of a and b by p. */
export function mix(a: number, b: number, p: number): number;
/** Eased 0..1 ramp from frame a to frame b. */
export function ramp(f: number, a: number, b: number): number;
/** Opacity window: eased in over frames a0..a1, eased out over b0..b1. */
export function win(f: number, a0: number, a1: number, b0: number, b1: number): number;
/** Radians of k whole cycles over total frames: a phase that repeats exactly (use total = durationInFrames - 1). */
export function cycle(f: number, total: number, k?: number): number;
/** Rotor degrees at frame: speed keys [frame, degPerFrame], ends on a multiple of sym so the last frame equals frame 0. */
export function rotorAngle(frame: number, total: number, keys: readonly (readonly [number, number])[], sym: number): number;
/** Easing curve for 0..1 values: fast start, soft landing. */
export const EASE_OUT: (t: number) => number;
/** Easing curve for 0..1 values: soft start and end. */
export const EASE_INOUT: (t: number) => number;
/** Brand colour names accepted wherever a colour prop is taken: indigo violet teal yellow pink ink white cyan blue red orange. */
export const PALETTE: Readonly<Record<string, string>>;
/** Font stacks for your own text: display (Space Grotesk headlines), body (Inter), mono (JetBrains Mono code). */
export const FONTS: Readonly<{ display: string; body: string; mono: string }>;
