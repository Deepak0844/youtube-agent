import React from 'react';
export declare function mulberry32(a: number): () => number;
export declare function montyTrials(seed: number, n: number): boolean[];
export declare const Door: React.FC<{
    x: number;
    y: number;
    w: number;
    h: number;
    n: string;
    content: 'car' | 'goat';
    openP?: number;
    pickedP?: number;
    switchP?: number;
    removedP?: number;
    glow?: number;
    accent?: string;
    good?: string;
    bad?: string;
}>;
export declare const ProbChip: React.FC<{
    x: number;
    y: number;
    text: string;
    color?: string;
    p?: number;
    big?: boolean;
}>;
export declare const Brace: React.FC<{
    x1: number;
    x2: number;
    y: number;
    label: string;
    color?: string;
    p?: number;
}>;
export declare const TallyGrid: React.FC<{
    trials: boolean[];
    shown: number;
    x: number;
    y: number;
    cols?: number;
    cell?: number;
    gap?: number;
    winColor?: string;
    loseColor?: string;
}>;
export declare const BigPct: React.FC<{
    x: number;
    y: number;
    label: string;
    value: number;
    color?: string;
    w?: number;
}>;
export declare const usePulse: (period?: number, amp?: number) => number;
