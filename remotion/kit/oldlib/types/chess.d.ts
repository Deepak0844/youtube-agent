import React from 'react';
export type Sq = string;
export type Piece = 'wK' | 'wQ' | 'wR' | 'wB' | 'wN' | 'wP' | 'bK' | 'bQ' | 'bR' | 'bB' | 'bN' | 'bP';
export type BoardMap = Record<string, Piece>;
export declare const sqRC: (sq: Sq, flip?: boolean) => {
    col: number;
    row: number;
};
export declare const sqCenter: (sq: Sq, size: number, flip?: boolean) => {
    x: number;
    y: number;
};
export declare const fenBoard: (placement: string) => BoardMap;
export declare const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR";
export type BoardMove = {
    from: Sq;
    to: Sq;
    at: number;
    dur?: number;
    restore?: {
        sq: Sq;
        code: Piece;
    };
};
export type Highlight = {
    sq: Sq;
    color: string;
    at?: number;
    until?: number;
};
export type Arrow = {
    from: Sq;
    to: Sq;
    color: string;
    at?: number;
    until?: number;
    dashed?: boolean;
};
type Sprite = {
    code: Piece;
    col: number;
    row: number;
    opacity: number;
    lift: number;
    key: string;
};
export declare const boardAtFrame: (start: BoardMap, moves: BoardMove[], frame: number, flip?: boolean) => Sprite[];
export type BoardTheme = {
    light: string;
    dark: string;
    frame: string;
    label: string;
};
export declare const CLASSIC: BoardTheme;
export declare const ChessBoard: React.FC<{
    size: number;
    board: BoardMap;
    moves?: BoardMove[];
    highlights?: Highlight[];
    arrows?: Arrow[];
    flip?: boolean;
    theme?: BoardTheme;
    x?: number;
    y?: number;
}>;
export {};
