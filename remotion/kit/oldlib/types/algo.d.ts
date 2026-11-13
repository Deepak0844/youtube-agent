import React from 'react';
export declare const seededShuffle: (n: number, seed: number) => number[];
export type SortOp = {
    a: number[];
    hi: [number, number];
    swap: boolean;
};
export declare const bubbleSteps: (initial: number[]) => SortOp[];
export declare const quickSteps: (initial: number[]) => SortOp[];
export declare const raceState: (initial: number[], steps: SortOp[], opsDone: number) => {
    values: number[];
    hi: [number, number] | null;
    ops: number;
    done: boolean;
};
export declare const BarPanel: React.FC<{
    x: number;
    y: number;
    w: number;
    h: number;
    label: string;
    color: string;
    values: number[];
    max: number;
    hi: [number, number] | null;
    ops: number;
    labelAt?: number;
    doneAtFrame?: number;
    doneText?: string;
    good?: string;
}>;
export type SearchStep = {
    lo: number;
    hi: number;
    mid: number;
    dir: -1 | 0 | 1;
};
export declare const binarySearchSteps: (n: number, target: number) => SearchStep[];
export declare const fmt: (v: number) => string;
export type SearchView = {
    i: number;
    step: SearchStep;
    dispLo: number;
    dispHi: number;
    keepLo: number;
    keepHi: number;
    markerP: number;
    markerOut: number;
    verdictP: number;
    dimP: number;
    guesses: number;
    left: number;
    done: boolean;
    allSizes: number[];
};
export declare const searchViewAt: (steps: SearchStep[], t: number, durOf: (i: number) => number) => SearchView;
export declare const RangeBoard: React.FC<{
    n: number;
    target: number;
    view: SearchView;
    y0: number;
    scan?: {
        p: number;
    };
    pill?: {
        text: string;
        color: string;
    };
    opacity?: number;
}>;
