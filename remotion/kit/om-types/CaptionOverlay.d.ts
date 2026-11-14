import React from "react";
export interface WordCaption {
    word: string;
    startMs: number;
    endMs: number;
    pageBreakAfter?: boolean;
}
type CaptionOverlayProps = {
    words: WordCaption[];
    wordsPerPage?: number;
    fontSize?: number;
    color?: string;
    highlightColor?: string;
    backgroundColor?: string;
    fontFamily?: string;
    wordSeparator?: string;
    direction?: "ltr" | "rtl" | "auto";
    bottomOffset?: number;
    boxStyle?: React.CSSProperties;
    textStyle?: React.CSSProperties;
    wordStyle?: React.CSSProperties;
    inactiveWordStyle?: React.CSSProperties;
    wordPop?: {
        scale: number;
        damping?: number;
        stiffness?: number;
    };
};
export type CaptionProps = Partial<CaptionOverlayProps>;
export declare const CaptionOverlay: React.FC<CaptionOverlayProps>;
export {};
