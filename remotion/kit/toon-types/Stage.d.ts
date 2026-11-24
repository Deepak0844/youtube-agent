import React from "react";
import { type ToonRuntime } from "./runtime";
export declare const RuntimeContext: React.Context<ToonRuntime | null>;
export declare const useRuntime: () => ToonRuntime;
export type ToonPalette = Partial<Record<"ink" | "paper" | "gold" | "wine" | "black" | "blue" | "red" | "sky" | "green", string>>;
/** The time helpers a scene may read while it draws (seconds from the start of the video). */
export type ToonClock = {
    t: number;
    T: (mark: string | number) => number;
    prog: (t: number, a: string | number, b: string | number) => number;
};
export declare const eout: (x: number) => number;
export declare const eio: (x: number) => number;
export declare const clamp: (x: number, a?: number, b?: number) => number;
export declare const lerp: (a: number, b: number, k: number) => number;
export declare function useToon(): ToonClock;
/** Runs `fn` once, after this component's DOM exists and before the film wires its animations (children first). */
export declare function useToonBuild(fn: (rt: ToonRuntime) => void): void;
export declare const ToonFilm: React.FC<{
    palette?: ToonPalette;
    bg?: string;
    children?: React.ReactNode;
}>;
