import React from 'react';
export type Pt = {
    x: number;
    y: number;
};
export type Box = {
    x: number;
    y: number;
    w: number;
    h: number;
};
export declare const contribSeries: (monthly: number, annualRate: number, years: number) => Pt[];
export declare const slicePts: (pts: Pt[], p: number) => Pt[];
export declare const lastPt: (pts: Pt[]) => Pt;
export type Scale = {
    sx: (x: number) => number;
    sy: (y: number) => number;
    box: Box;
};
export declare const makeScale: (xDomain: [number, number], yDomain: [number, number], box: Box) => Scale;
export declare const money: (v: number) => string;
export declare const moneyShort: (v: number) => string;
export declare const ChartFrame: React.FC<{
    scale: Scale;
    yTicks: number[];
    xTicks: number[];
    yFormat?: (v: number) => string;
    xFormat?: (v: number) => string;
    grid?: string;
    axis?: string;
    label?: string;
    opacity?: number;
}>;
export declare const Curve: React.FC<{
    scale: Scale;
    pts: Pt[];
    color: string;
    p?: number;
    width?: number;
    glow?: number;
    dashed?: boolean;
    opacity?: number;
}>;
export declare const GapArea: React.FC<{
    scale: Scale;
    upper: Pt[];
    lower: Pt[];
    color: string;
    p?: number;
    opacity?: number;
    hatch?: boolean;
}>;
export declare const EndDot: React.FC<{
    scale: Scale;
    pts: Pt[];
    p?: number;
    color: string;
    label?: string;
    value?: number;
    format?: (v: number) => string;
    dy?: number;
    dx?: number;
    anchor?: 'middle' | 'end';
    plate?: boolean;
    pulse?: number;
    opacity?: number;
}>;
export declare const Ticker: React.FC<{
    value: number;
    p?: number;
    label?: string;
    color: string;
    x?: number;
    y?: number;
    size?: number;
    format?: (v: number) => string;
    opacity?: number;
}>;
export declare const ShareBar: React.FC<{
    x: number;
    y: number;
    w: number;
    h?: number;
    share: number;
    p?: number;
    keepColor?: string;
    lostColor?: string;
    keepLabel?: string;
    lostLabel?: string;
    opacity?: number;
}>;
export declare const Legend: React.FC<{
    items: {
        color: string;
        text: string;
    }[];
    x: number;
    y: number;
    size?: number;
    opacity?: number;
}>;
