import React from "react";
import { type PoseName, type Pose, type PuppetFrame } from "./comic";
/** A hand-cut closed outline through the polygon [[x, y], ...] (a path `d`); the same points and seed give the same edge every frame. */
export declare const torn: (pts: number[][], amp?: number, seed?: number, step?: number) => string;
/** Points for a hill, skyline or wave line from x0 to x1, closed down to yb: the top at x is hFn(x). */
export declare const ridge: (x0: number, x1: number, yb: number, hFn: (x: number) => number, step?: number) => number[][];
/** Parallax transform for a camera layer: depth 1 moves most, bigger depths move less; push 0..1 over the shot. */
export declare const parallax: (depth: number, push: number, cx?: number, cy?: number, amount?: number, pan?: [number, number]) => string;
/** cartoon-shorts' seeded random numbers: const R = rng(12); R() gives the same 0..1 sequence every time. */
export declare const rng: (seed: number) => (() => number);
/** 14609 -> "14,609". */
export declare const thousands: (n: number) => string;
export type GradStops = [number, string, number?][];
/** A rectangle filled with a vertical gradient (top to bottom): stops [[offset, colour, opacity?], ...]. */
export declare const GradRect: React.FC<{
    x?: number;
    y?: number;
    width: number;
    height: number;
    stops: GradStops;
}>;
/** One paper layer: flat colour (or a vertical gradient `grad`), a lighter cut edge on top, a shadow beneath. `pts` is torn; a string is a path used as is. */
export declare const Layer: React.FC<{
    pts: number[][] | string;
    fill?: string;
    amp?: number;
    seed?: number;
    step?: number;
    grad?: GradStops;
    small?: boolean;
    shadow?: boolean;
    edge?: string | false;
    ew?: number;
}>;
/** A soft radial glow (screen blend). */
export declare const Glow: React.FC<{
    x: number;
    y: number;
    r: number;
    color: string;
    op?: number;
}>;
/** A fan of `n` light rays from (x, y) toward `ang` degrees (0 right, 90 down, 180 left), flickering with time. */
export declare const Rays: React.FC<{
    x: number;
    y: number;
    ang: number;
    spread: number;
    len: number;
    n: number;
    color: string;
    op?: number;
    seed?: number;
}>;
/** Dust or embers drifting in the box [x0, y0, w, h]. `up` px/s (18), `drift` (6), `size` (3), `op` (.7). */
export declare const Dust: React.FC<{
    n: number;
    box: [number, number, number, number];
    color?: string;
    seed?: number;
    up?: number;
    drift?: number;
    size?: number;
    op?: number;
}>;
/** Paper confetti falling over the full 1080 width, each piece with a small shadow. */
export declare const PaperConfetti: React.FC<{
    n: number;
    seed?: number;
    colors?: string[];
    speed?: number;
}>;
/** A sky of small stars over the box 1080 x h: `n` dots from `seed`, radius rBase + R * rVar, opacity opBase + R * opVar. */
export declare const StarField: React.FC<{
    n: number;
    seed: number;
    h: number;
    color?: string;
    rBase?: number;
    rVar?: number;
    opBase?: number;
    opVar?: number;
}>;
/** Cut-out lettering (Fraunces 900 by default): `y` is the baseline, centred by default. */
export declare const Word: React.FC<{
    x: number;
    y: number;
    text: string;
    size: number;
    fill?: string;
    font?: string;
    weight?: number;
    italic?: boolean;
    anchor?: "start" | "middle" | "end";
    ls?: number;
    shadow?: boolean;
}>;
/** A paper card with a word on it, scaling in with a small overshoot (k 0..1, nothing is drawn at 0). */
export declare const Card: React.FC<{
    k: number;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    text: string;
    size: number;
    rot?: number;
    seed?: number;
    fill?: string;
    italic?: boolean;
    font?: string;
    weight?: number;
    ls?: number;
}>;
/** Silhouette light: the shape is filled with `dark`, with a rim of `rim` on the side the offset (dx, dy) points to. */
export type Rim = {
    dark?: string;
    rim?: string;
    dx?: number;
    dy?: number;
    glow?: number;
};
/**
 * A full-body backlit silhouette from the puppet rig. Give it an `id` so a <Follow> can hold a candle or a lamp at its hand. `look` adds puppet
 * options over the all-black look (for example { cap: "#000", beard: true, legs: "pants" }); `act` is the puppet's pose and place, as for Puppet.
 */
export declare const Figure: React.FC<{
    id?: string;
    look?: Record<string, string | number | boolean | null>;
    rim?: Rim;
    act: (t: number) => PuppetFrame;
}>;
/** A man in profile facing right (swept-back hair, glasses, suit). Origin near the ear; head top at y - 178, shoulders end at y + 330 (times s). */
export declare const Profile: React.FC<{
    x: number;
    y: number;
    s?: number;
    dir?: 1 | -1;
    rim?: Rim;
    glint?: string;
}>;
export type { Pose, PoseName };
