import React from 'react';
export type SheetTheme = 'excel' | 'sheets';
export type SheetCol = {
    letter: string;
    header: string;
    width: number;
};
export declare const SHEET: {
    x: number;
    yTop: number;
    gutterW: number;
    letterH: number;
    rowH: number;
    cols: SheetCol[];
};
export declare const sheetWidth: (cols?: SheetCol[]) => number;
export type CellView = {
    text: string;
    box?: 'sel' | 'active' | null;
    cursor?: boolean;
    flash?: number;
    mono?: boolean;
};
export declare const SheetGrid: React.FC<{
    theme?: SheetTheme;
    cols?: SheetCol[];
    cells: CellView[][];
    fillHandle?: boolean;
}>;
export declare const FormulaBar: React.FC<{
    theme?: SheetTheme;
    cellRef: string;
    content: string;
    cursor?: boolean;
    y?: number;
}>;
export declare const KeyCombo: React.FC<{
    keys: string[];
    x?: number;
    y: number;
    press?: number;
    glow?: number;
    theme?: SheetTheme;
    scale?: number;
}>;
export declare const pressPulse: (frame: number, at: number, len?: number) => number;
export type FlashCue = {
    typeStart: number;
    typeEnd: number;
    cascadeStart: number;
    stagger: number;
};
export declare const flashFillCol: (vals: string[], cue: FlashCue, frame: number) => CellView[];
