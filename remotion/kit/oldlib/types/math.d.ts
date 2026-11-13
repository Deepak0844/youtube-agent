import React from 'react';
export declare const DigitTile: React.FC<{
    x: number;
    y: number;
    size: number;
    digit: string;
    rollTo?: {
        digit: string;
        p: number;
    };
    color?: string;
    border?: string;
    opacity?: number;
    scale?: number;
    flash?: number;
    flashColor?: string;
}>;
export declare const EqRow: React.FC<{
    tokens: {
        t: string;
        color?: string;
        pulse?: boolean;
    }[];
    y: number;
    size?: number;
    gap?: number;
    warm?: boolean;
}>;
export declare const TimesElevenDemo: React.FC<{
    a: number;
    b: number;
    t: {
        split: number;
        sum: number;
        drop: number;
        carry?: number;
        result: number;
    };
    y?: number;
    size?: number;
    accent?: string;
    good?: string;
}>;
