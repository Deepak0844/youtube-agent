import React from 'react';
export type TermKind = 'cmd' | 'out' | 'dim' | 'warn' | 'err' | 'ok' | 'path';
export type TermLine = {
    text: string;
    kind?: TermKind;
    at?: number;
    type?: boolean;
    cps?: number;
    gap?: number;
    hl?: string;
    hlAt?: number;
    prompt?: string;
};
export declare const TerminalWindow: React.FC<{
    box: {
        x: number;
        y: number;
        w: number;
        h: number;
    };
    lines: TermLine[];
    title?: string;
    promptPath?: string;
    fontSize?: number;
    lineH?: number;
    appearAt?: number;
    pad?: number;
}>;
