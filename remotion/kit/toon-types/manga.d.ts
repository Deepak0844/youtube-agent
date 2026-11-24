import React from "react";
/**
 * Look options: head (lean | square | round), nose (small | long | wide), hairStyle (spiky | swept | buzz), skin, skinS, hair, hairS, hairH, eyeW, eyeH,
 * eyeGap, pupil, mouthW, age, glasses, frame, stubble, outfit (kit | suit), shirt, shirtS, trim, suit, suitS, tie, collar. `headband` (a colour) adds a
 * tied headband that follows the head.
 */
export type MangaLook = Record<string, string | number | boolean | null>;
/** Face of one moment. eyes: open | happy | closed | wide | fierce; mouth: smile | smirk | line | frown | grin | shout | cry; look [x, y] -1..1; lid, brow, open, tears (+ fountain), blush, sweat, shade, glare, turn, tilt. */
export type MangaExpression = {
    eyes?: "open" | "happy" | "closed" | "wide" | "fierce";
    look?: [number, number];
    lid?: number;
    brow?: number;
    mouth?: "smile" | "smirk" | "line" | "frown" | "grin" | "shout" | "cry";
    open?: number;
    tears?: number;
    fountain?: boolean;
    blush?: number;
    sweat?: boolean;
    shade?: number;
    glare?: boolean;
    turn?: number;
    tilt?: number;
};
export type MangaBustFrame = {
    x: number;
    y: number;
    s: number;
    ex?: MangaExpression;
};
export declare const Bust: React.FC<{
    who?: string;
    look?: MangaLook;
    act: (t: number) => MangaBustFrame;
}>;
type Mark = string | number;
/** Parallel ink strokes clipped to the path `d`, over the box x0,y0 .. x1,y1: manga hatching for the darkest shadows. */
export declare const Hatch: React.FC<{
    d: string;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    gap?: number;
    ang?: number;
    w?: number;
    op?: number;
}>;
/** Sound-effect lettering: heavy, tilted, double outline, centred on x with its baseline at y. Pass `size * ease` to pop it in. */
export declare const Sfx: React.FC<{
    x: number;
    y: number;
    text: string;
    size?: number;
    rot?: number;
    fill?: string;
}>;
/** Confetti falling over the whole frame, drawn with manga ink outlines; `n` pieces, `seed` picks the pattern. */
export declare const ConfettiRain: React.FC<{
    n: number;
    seed: number;
}>;
export type { Mark };
