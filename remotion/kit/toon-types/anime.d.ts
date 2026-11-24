import React from "react";
export type AnimeLook = Record<string, string | number | boolean | null>;
/** Face of one moment (every field optional). eyes: open | wide | happy | closed; mouth: smile | soft | line | frown | grin | open | shout; look [x, y] -1..1; lid, brow, browY, open, tears, wet, blush, turn, tilt, shine; sweat. */
export type AnimeExpression = {
    eyes?: "open" | "wide" | "happy" | "closed";
    look?: [number, number];
    lid?: number;
    brow?: number;
    browY?: number;
    mouth?: "smile" | "soft" | "line" | "frown" | "grin" | "open" | "shout";
    open?: number;
    tears?: number;
    blush?: number;
    sweat?: boolean;
    turn?: number;
    tilt?: number;
    wet?: number;
    shine?: number;
};
/** Where the bust is and what its face does: (x, y) is the eye line, `s` the scale (1 = head about 360 units tall), `ex` the expression. */
export type BustFrame = {
    x: number;
    y: number;
    s: number;
    ex?: AnimeExpression;
};
/**
 * An anime bust, drawn again for every frame from `act(t)`. `look` is the one-off look (skin, hair, hairStyle spiky | swept | buzz | long, iris,
 * eyeW, eyeH, eyeGap, lash, jaw, glasses, outfit kit | suit, shirt, tie, ...); `who` takes the look from the series cast.
 */
export declare const Bust: React.FC<{
    who?: string;
    look?: AnimeLook;
    act: (t: number) => BustFrame;
}>;
type Mark = string | number;
/** Focus lines aimed at (cx, cy), the classic anime impact background; `spin` turns them slowly (degrees per second, negative = the other way). */
export declare const SpeedLines: React.FC<{
    cx: number;
    cy: number;
    r0: number;
    r1: number;
    n: number;
    color?: string;
    op?: number;
    seed?: number;
    spin?: number;
}>;
/** Parallel motion streaks in a box (x, y, w, h) turned by `ang` degrees. */
export declare const Streaks: React.FC<{
    x: number;
    y: number;
    w: number;
    h: number;
    n: number;
    ang: number;
    color?: string;
    op?: number;
    seed?: number;
}>;
/** Four-point star. Draw it at radius 1 inside a <g transform=...> to animate it. */
export declare const Sparkle: React.FC<{
    x: number;
    y: number;
    r: number;
    color?: string;
    op?: number;
}>;
/** A soft circle of light with its own radial gradient; wrap it in a <g transform=...> to move it. */
export declare const Bokeh: React.FC<{
    x: number;
    y: number;
    r: number;
    color: string;
    op?: number;
}>;
/** A 1080 x 1920 film-grain noise layer. */
export declare const Grain: React.FC<{
    op?: number;
}>;
/** A gaussian blur filter with this id: filter="url(#id)" on a group blurs it. */
export declare const BlurFilter: React.FC<{
    id: string;
    sd: number;
}>;
export type { Mark };
/** cartoon-shorts' seeded random numbers: const R = rng(21); R() gives the same 0..1 sequence every time. */
export declare const rng: (seed: number) => (() => number);
