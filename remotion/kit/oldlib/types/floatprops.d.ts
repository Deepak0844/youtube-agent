import React from 'react';
export declare const WOOD: {
    readonly dark: "#3d2a1c";
    readonly mid: "#5a3d26";
    readonly light: "#7a5436";
    readonly plank: "#684933";
};
export declare const BRASS = "#c9a35a";
export declare const LIQUID: "#4db8a8";
export declare const WorkbenchGlow: React.FC<{
    totalFrames: number;
}>;
export declare const GlassJug: React.FC<{
    x: number;
    y: number;
    w: number;
    label: string;
    tilt?: number;
    streamLen?: number;
    flip?: boolean;
}>;
export declare const MeasuringCup: React.FC<{
    x: number;
    y: number;
    w: number;
    fillPct?: number;
    totalFrames: number;
}>;
export declare const HoloReadout: React.FC<{
    x: number;
    y: number;
    value: string;
    tailChars?: number;
    size?: number;
    totalFrames: number;
    enterAt?: number;
}>;
export declare const DigitGhostThread: React.FC<{
    x: number;
    y: number;
    text: string;
    at?: number;
}>;
export type FoldStage = {
    atLocal: number;
    label: string;
    fail?: boolean;
};
export declare const FoldTape: React.FC<{
    x: number;
    y: number;
    w: number;
    stages: FoldStage[];
}>;
export declare const BrassTerminal: React.FC<{
    x: number;
    y: number;
    w: number;
    h: number;
    lineA: string;
    lineB: string;
    converge: number;
}>;
