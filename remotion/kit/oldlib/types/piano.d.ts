import React from 'react';
/** "C4" | "A#3" -> MIDI number (C4 = 60, A4 = 69). */
export declare const toMidi: (note: string) => number;
/** Equal temperament, A4 = 440 Hz — the same formula gen_chords.py synthesizes with. */
export declare const toHz: (note: string) => number;
export declare const isBlack: (midi: number) => boolean;
export type Lit = {
    note: string;
    color: string;
    amount: number;
};
export declare const Keyboard: React.FC<{
    from?: string;
    to?: string;
    lit?: Lit[];
    x?: number;
    y?: number;
    w?: number;
    h?: number;
}>;
export declare const ChordChip: React.FC<{
    label: string;
    roman?: string;
    x: number;
    y: number;
    color?: string;
    at?: number;
    active?: number;
    w?: number;
}>;
export declare const SongStamp: React.FC<{
    title: string;
    artist: string;
    x?: number;
    y: number;
    at: number;
    until?: number;
    color?: string;
}>;
export declare const strike: (frame: number, at: number, fps?: number, release?: number) => number;
