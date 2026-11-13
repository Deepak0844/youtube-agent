import React from 'react';
export declare const VOX: {
    readonly paper: "#efe6d3";
    readonly paperDeep: "#e0d2b8";
    readonly ink: "#282217";
    readonly inkSoft: "#544a3a";
    readonly red: "#c0392b";
    readonly yellow: "#e8b73a";
    readonly teal: "#33695d";
    readonly cream: "#faf5ea";
};
export declare const EASE_OUT: (t: number) => number;
export declare const EASE_INOUT: (t: number) => number;
export declare const EASE_PLACE: (t: number) => number;
export type CamKey = {
    f: number;
    x: number;
    y: number;
    z: number;
};
export declare const CollageBoard: React.FC<{
    cam: CamKey[];
    children: React.ReactNode;
}>;
export type Enter = 'pop' | 'place' | 'slide-l' | 'slide-r' | 'rise' | 'fade' | 'wipe' | 'none';
export declare const Layer: React.FC<{
    x: number;
    y: number;
    w: number;
    at?: number;
    dur?: number;
    enter?: Enter;
    rotate?: number;
    depth?: number;
    drift?: number;
    z?: number;
    children: React.ReactNode;
}>;
export declare const Cutout: React.FC<{
    src: string;
    x: number;
    y: number;
    w: number;
    at?: number;
    dur?: number;
    enter?: Enter;
    rotate?: number;
    depth?: number;
    drift?: number;
    sticker?: number;
    shadow?: number;
    z?: number;
}>;
export declare const ArchivalPhoto: React.FC<{
    src: string;
    x: number;
    y: number;
    w: number;
    at?: number;
    dur?: number;
    enter?: Enter;
    rotate?: number;
    depth?: number;
    drift?: number;
    tape?: boolean;
    treatment?: 'sepia' | 'mono' | 'none';
    caption?: string;
    z?: number;
}>;
export declare const PaperBG: React.FC<{
    src?: string;
    w: number;
    h: number;
    depth?: number;
}>;
export declare const Grain: React.FC<{
    opacity?: number;
}>;
export declare const LabelChip: React.FC<{
    text: string;
    x: number;
    y: number;
    at?: number;
    size?: number;
    rotate?: number;
    accent?: string;
    kicker?: string;
    kickerColor?: string;
    depth?: number;
    z?: number;
}>;
export declare const SerifStatement: React.FC<{
    words: {
        t: string;
        hl?: boolean;
    }[];
    x: number;
    y: number;
    w: number;
    at?: number;
    size?: number;
    color?: string;
    hlColor?: string;
    align?: 'left' | 'center';
    backing?: boolean;
    depth?: number;
    z?: number;
}>;
export declare const RubberStamp: React.FC<{
    text: string;
    x: number;
    y: number;
    at?: number;
    size?: number;
    color?: string;
    rotate?: number;
    depth?: number;
    z?: number;
}>;
export declare const SketchArrow: React.FC<{
    d: string;
    vb: {
        w: number;
        h: number;
    };
    at?: number;
    dur?: number;
    color?: string;
    width?: number;
    dashed?: boolean;
    head?: boolean;
    id: string;
    z?: number;
}>;
