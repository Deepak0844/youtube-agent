import React from 'react';
export declare const SHORT: {
    readonly W: 1080;
    readonly H: 1920;
    readonly FPS: 30;
};
export declare const SAFE: {
    readonly top: 150;
    readonly bottom: 500;
    readonly right: 160;
    readonly left: 60;
};
export declare const EASE_OUT: (t: number) => number;
export declare const EASE_INOUT: (t: number) => number;
export declare const prog: (t: number, a: number, b: number) => number;
export type TimedWord = {
    w: string;
    start: number;
    end: number;
};
export type VoLine = {
    text: string;
    start: number;
    end: number;
    words?: TimedWord[];
};
export declare const timeWords: (line: VoLine) => TimedWord[];
type Chunk = {
    words: TimedWord[];
    start: number;
    end: number;
    hold: number;
};
export declare const chunkLines: (lines: VoLine[], maxWords?: number) => Chunk[];
export declare const Captions: React.FC<{
    lines: VoLine[];
    y?: number;
    size?: number;
    accent?: string;
    maxWords?: number;
    plate?: boolean;
}>;
export declare const ProgressBar: React.FC<{
    color?: string;
}>;
export declare const Kicker: React.FC<{
    text: string;
    color?: string;
    y?: number;
    at?: number;
    until?: number;
}>;
export declare const BigTitle: React.FC<{
    lines: {
        text: string;
        color?: string;
    }[];
    subtitle?: string;
    y?: number;
    size?: number;
    warm?: boolean;
}>;
export declare const Stamp: React.FC<{
    text: string;
    at?: number;
    until?: number;
    color?: string;
    x?: number;
    y?: number;
    size?: number;
    rotate?: number;
}>;
export declare const PauseCard: React.FC<{
    title?: string;
    subtitle?: string;
    durSec: number;
    accent?: string;
    y?: number;
}>;
export declare const StatChip: React.FC<{
    label: string;
    value: string;
    color?: string;
    x: number;
    y: number;
    w?: number;
    at?: number;
}>;
export declare const ShortsBackdrop: React.FC<{
    base?: string;
    glow?: string;
}>;
export declare const SafeAreaGuides: React.FC;
export {};
