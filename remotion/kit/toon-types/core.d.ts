import React from "react";
import { clamp, eio, eout, lerp, ToonFilm, useToon, type ToonClock, type ToonPalette } from "./Stage";
import { type ToonCharacter, type ToonInput } from "./context";
export { ToonFilm, useToon, eout, eio, clamp, lerp };
export type { ToonClock, ToonPalette, ToonCharacter, ToonInput };
/** The SVG transform string cartoon-shorts uses for a moved piece: translate(x,y) rotate(r) scale(s). */
export declare const trf: (x: number, y: number, s?: number, r?: number) => string;
export declare const ENTRANCE_PRESETS: readonly ["slam", "smash", "up", "down", "left", "right", "fade", "out", "pop", "stamp", "growx", "growy", "nudge", "wipe"];
export type EntrancePreset = (typeof ENTRANCE_PRESETS)[number];
export type Transition = "flash" | "zoom" | "whip" | "glitch" | "cut";
/** A comic sound word: a burst star that pops in at `at` with the word on top, until `until`. Position is the centre of the word (stage units). */
export type SoundWord = {
    word: string;
    x: number;
    y: number;
    rot: number;
    at: string | number;
    until: string | number;
    fill?: string;
    size?: number;
};
/**
 * One scene of the film: shown only between its start and its end (the scene id must be in the timeline), entered with `tr`.
 * `children` are drawn in the scene's SVG layer (1080 x 1920 portrait, 1920 x 1080 landscape) and move with <Camera>; `above` is SVG drawn over
 * that layer which the camera does not move; `words` are comic sound words (burst + word, above the camera); `overlays` are HTML text boxes
 * (<Ov>), drawn over everything, after the sound words.
 */
export declare const Scene: React.FC<{
    id: string;
    tr?: Transition;
    children?: React.ReactNode;
    above?: React.ReactNode;
    words?: SoundWord[];
    overlays?: React.ReactNode;
}>;
/** `slam@B3+.2` style entrance list: one preset at a time or several ("slam" in, "out" later). */
export type EntranceStep = {
    preset: EntrancePreset;
    at: string | number;
    dur?: number;
};
/** An HTML text box over the scene (titles, kickers, labels, cards). `css` is the box's position and look, e.g. "left:0;right:0;top:300px;text-align:center"; `during` shows it only in a window of marks ("B2..B4e"). */
export declare const Ov: React.FC<{
    css?: string;
    cls?: string;
    enter?: EntranceStep[];
    during?: string;
    fit?: boolean;
    children?: React.ReactNode;
}>;
/** Wraps SVG drawing in an entrance preset (slam, pop, up, fade...) at a mark. */
export declare const Anim: React.FC<{
    preset: EntrancePreset;
    at: string | number;
    dur?: number;
    also?: EntranceStep[];
    children?: React.ReactNode;
}>;
/** Shows its SVG children only between two marks. */
export declare const Show: React.FC<{
    from: string | number;
    to: string | number;
    children?: React.ReactNode;
}>;
/** Slow camera push over the scene (or a window of it): scale `from` -> `to` around (cx, cy). Do not combine it with a style's own camera. */
export declare const Camera: React.FC<{
    a?: string | number;
    b?: string | number;
    from?: number;
    to?: number;
    cx?: number;
    cy?: number;
}>;
/** The whole frame shakes at a mark. */
export declare const Shake: React.FC<{
    at: string | number;
    dur?: number;
    amp?: number;
}>;
/** A hit frame: inverted for a few frames, then a colour split. Put <FlashAt> 0.1 s later, not at the same time. */
export declare const Impact: React.FC<{
    at: string | number;
    frames?: number;
}>;
export declare const Chroma: React.FC<{
    at: string | number;
    dur?: number;
    px?: number;
}>;
export declare const FlashAt: React.FC<{
    at: string | number;
    opacity?: number;
    dur?: number;
}>;
export type GradStop = [offset: number, color: string, opacity?: number];
export declare const LinGrad: React.FC<{
    id: string;
    stops: GradStop[];
    x1?: number;
    y1?: number;
    x2?: number;
    y2?: number;
}>;
export declare const RadGrad: React.FC<{
    id: string;
    stops: GradStop[];
    cx?: number;
    cy?: number;
    r?: number;
}>;
export declare const DotsPattern: React.FC<{
    id: string;
    color?: string;
    size?: number;
    r?: number;
    op?: number;
}>;
