import React from "react";
/** Blend two 6-digit hex colours: mixColor("#fbeec8", "#f0c060", 0.5). */
export declare const mixColor: (a: string, b: string, k: number) => string;
/** The full 1080 x 1920 meadow: sky, sun glow, clouds, mountains, hills, village, flowers and sheep; clouds drift and sheep hop. */
export declare const Landscape: React.FC<{
    sheepOn?: boolean;
    seed?: number;
}>;
/** The warm kitchen: wall, beam, window with a live landscape, curtains, shelf, tiles. hang: false hides the cured meats on hooks. Draw the Counter after the Cook. */
export declare const Kitchen: React.FC<{
    counterY?: number;
    hang?: boolean;
}>;
/** The wooden counter top and front from y to the bottom of the frame. */
export declare const Counter: React.FC<{
    y?: number;
}>;
export declare const Cloud: React.FC<{
    x: number;
    y: number;
    s?: number;
    seed?: number;
}>;
export declare const Sheep: React.FC<{
    x: number;
    y: number;
    s?: number;
    flip?: 1 | -1;
}>;
export declare const Village: React.FC<{
    x: number;
    y: number;
    s?: number;
}>;
/** Arm angles [a1, a2] in degrees: a1 swings the upper arm out from straight down, a2 bends the elbow. Arms up: [150, 50]. */
export type CookFrame = {
    la?: [number, number];
    ra?: [number, number];
    headR?: number;
    /** 0..1 mouth, or "voice" to open it while a narration line plays */
    talk?: number | "voice";
    /** true closes the eyes, or "auto" blinks every 3.4 s */
    blink?: boolean | "auto";
    happy?: boolean;
    point?: "l" | "r" | null;
    bob?: number;
    lean?: number;
};
/**
 * The round friendly cook. At s = 1 the hair top is about y - 362, the shoulders at (x +- 142, y + 80), the body ends at y + 640. act(t) gives the
 * arms, face and bounce for each frame. Give it an id so a Follow can hold a spoon in its hand (at hand = right, fhand = left).
 */
export declare const Cook: React.FC<{
    id?: string;
    x?: number;
    y?: number;
    s?: number;
    skin?: string;
    hair?: string;
    top?: string;
    apron?: string;
    trim?: string;
    act: (t: number) => CookFrame;
}>;
export declare const Tomato: React.FC<{
    r?: number;
}>;
export declare const Garlic: React.FC<object>;
export declare const Onion: React.FC<object>;
export declare const Bacon: React.FC<object>;
export declare const Pecorino: React.FC<object>;
export declare const TomatoTin: React.FC<object>;
export declare const SpaghettiPack: React.FC<object>;
export declare const Guanciale: React.FC<{
    s?: number;
}>;
export declare const Bottle: React.FC<{
    glass?: string;
    label?: string;
    s?: number;
}>;
export declare const PepperMill: React.FC<{
    s?: number;
}>;
export declare const Peppercorns: React.FC<{
    n?: number;
    seed?: number;
}>;
export declare const SaltPinch: React.FC<{
    s?: number;
}>;
/** A white plate with a blue band and a soft shadow. */
export declare const Plate: React.FC<{
    rx?: number;
    ry?: number;
}>;
/** A heap of many thin strands (for a big hero plate use PastaNest). */
export declare const Nest: React.FC<{
    w?: number;
    h?: number;
    seed?: number;
    sauce?: boolean;
}>;
/** A few broad glossy pasta bands twirled into a nest, sauce, tomato chunks and basil on top. */
export declare const PastaNest: React.FC<{
    w?: number;
    h?: number;
    turns?: number;
    seed?: number;
    basil?: boolean;
}>;
export declare const Flames: React.FC<object>;
/** Soft white wisps of steam rising about 240 px times s; amt 0..1 scales the opacity (change it with time). */
export declare const Steam: React.FC<{
    x: number;
    y: number;
    n?: number;
    s?: number;
    amt?: number;
}>;
/** One bacon strip; cook 0..1 goes from raw to golden. */
export declare const Strip: React.FC<{
    s?: number;
    cook?: number;
}>;
/** A fork lifting a twirl of pasta; lift 0..1. */
export declare const Twirl: React.FC<{
    w?: number;
    h?: number;
    seed?: number;
    sauce?: boolean;
    lift?: number;
}>;
/** The iron pan seen from above (ellipse rx 340, ry 160, handle to x + 664 at s = 1). Children are drawn inside it, clipped to the pan. */
export declare const Pan: React.FC<{
    s?: number;
    children?: React.ReactNode;
}>;
/** The stock pot (about x +-300, y -206..210). Children are drawn on the water, clipped to the surface. */
export declare const Pot: React.FC<{
    s?: number;
    children?: React.ReactNode;
}>;
/** A bowl; children are drawn inside it. */
export declare const Bowl: React.FC<{
    s?: number;
    children?: React.ReactNode;
}>;
