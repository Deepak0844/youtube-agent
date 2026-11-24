import React from "react";
type Mark = string | number;
type Piece<P> = React.FC<P>;
export declare const Rays: Piece<{
    cx: number;
    cy: number;
    n: number;
    color: string;
    op?: number;
    speed?: number;
    r?: number;
}>;
/** Comic explosion star. */
export declare const Burst: Piece<{
    cx: number;
    cy: number;
    r1: number;
    r2: number;
    n: number;
    fill: string;
    stroke?: string;
    sw?: number;
    seed?: number;
}>;
export declare const SpeedLines: Piece<{
    cx: number;
    cy: number;
    rIn: number;
    rOut: number;
    n: number;
    color: string;
    a: Mark;
    b: Mark;
    w?: number;
}>;
export declare const Streaks: Piece<{
    x0: number;
    x1: number;
    y0: number;
    y1: number;
    n: number;
    color: string;
    a: Mark;
    b: Mark;
    speed?: number;
}>;
export declare const Confetti: Piece<{
    a: Mark;
    b: Mark;
    colors: string[];
    n?: number;
    x0?: number;
    x1?: number;
    y0?: number;
    fall?: number;
    seed?: number;
}>;
export declare const Flames: Piece<{
    cx: number;
    base: number;
    w: number;
    h: number;
    a: Mark;
    b: Mark;
}>;
export declare const Rain: Piece<{
    a: Mark;
    b: Mark;
    n?: number;
    color?: string;
    seed?: number;
}>;
/** Arena crowd; `excite` is a number 0..1 or a function of time. */
export declare const Crowd: Piece<{
    x0: number;
    x1: number;
    y0: number;
    rows: number;
    a: Mark;
    b: Mark;
    excite?: number | ((t: number) => number);
    seed?: number;
    dark?: number;
    palette?: string[] | null;
}>;
export declare const Stars: Piece<{
    n: number;
    w: number;
    h: number;
    seed?: number;
    op?: number;
}>;
export declare const Skyline: Piece<{
    x0: number;
    x1: number;
    base: number;
    color: string;
    seed?: number;
    hmin?: number;
    hmax?: number;
    lit?: string;
}>;
export declare const House: Piece<{
    x: number;
    y: number;
    w: number;
    h: number;
    wall: string;
    roof: string;
    lit?: boolean;
}>;
export declare const Palm: Piece<{
    x: number;
    y: number;
    s?: number;
    color?: string;
}>;
export declare const Trophy: Piece<{
    x: number;
    y: number;
    s?: number;
}>;
export declare const Ring: Piece<{
    x: number;
    y: number;
    s?: number;
    label?: string;
}>;
export declare const Jersey: Piece<{
    x: number;
    y: number;
    s: number;
    color: string;
    trim: string;
    num: string;
    numFill?: string;
    sleeves?: boolean;
}>;
export declare const Box: Piece<{
    x: number;
    y: number;
    w: number;
    h: number;
    label?: string;
}>;
export declare const Desk: Piece<{
    x: number;
    y: number;
    s?: number;
    color?: string;
}>;
export declare const Football: Piece<{
    x: number;
    y: number;
    s?: number;
    rot?: number;
}>;
export declare const School: Piece<{
    x: number;
    y: number;
    s?: number;
}>;
/** Street lamp with its light cone (uses the scene's gradients). */
export declare const Streetlight: Piece<{
    x: number;
    y: number;
    h?: number;
    glow?: string;
}>;
/** Side view of a court floor. */
export declare const Court: Piece<{
    x0: number;
    x1: number;
    y: number;
    h?: number;
}>;
/** A hoop; `net` gives the net's swing 0..1 for a time (0 = rest). */
export declare const Hoop: Piece<{
    x: number;
    y: number;
    s?: number;
    flip?: boolean;
    net?: (t: number) => number;
}>;
/** Springy pop-in of its children at a mark, scaled around (cx, cy). */
export declare const PopIn: Piece<{
    at: Mark;
    dur?: number;
    cx?: number;
    cy?: number;
    from?: number;
    children?: React.ReactNode;
}>;
/** A camera rig: its children are moved so the view looks at (cx, cy) with zoom and rotation between keys [[mark, cx, cy, zoom?, rot?, ease?], ...]. */
export declare const CamRig: Piece<{
    keys: [Mark, number, number, number?, number?, string?][];
    fx?: number;
    fy?: number;
    children?: React.ReactNode;
}>;
export {};
