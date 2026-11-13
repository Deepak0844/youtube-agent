import React from 'react';
export declare const CHROME: {
    readonly tab: 46;
    readonly nav: 56;
};
export declare const chromeH: (uiScale?: number) => number;
export declare const WebBrowserFrame: React.FC<{
    url: React.ReactNode;
    tabTitle: string;
    favicon?: React.ReactNode;
    box?: {
        x: number;
        y: number;
        w: number;
        h: number;
    };
    appearAt?: number;
    scrollY?: number;
    pageBg?: string;
    uiScale?: number;
    children?: React.ReactNode;
}>;
export declare const Marker: React.FC<{
    start: number;
    color?: string;
    children: React.ReactNode;
    pad?: number;
    radius?: number;
}>;
export declare const Ring: React.FC<{
    start: number;
    color?: string;
    style?: React.CSSProperties;
}>;
