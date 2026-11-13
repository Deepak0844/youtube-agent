import React from 'react';
export type NodeKind = 'laptop' | 'resolver' | 'root' | 'tld' | 'rack';
export declare const LaptopGlyph: React.FC<{
    size?: number;
    tint?: string;
}>;
export declare const ServerNodeGlyph: React.FC<{
    color: string;
    size?: number;
}>;
export declare const RackGlyph: React.FC<{
    size?: number;
    color?: string;
}>;
export declare const NetNode: React.FC<{
    x: number;
    y: number;
    kind: NodeKind;
    label: string;
    sub?: string;
    opacity?: number;
    scale?: number;
}>;
export declare const DashedConnector: React.FC<{
    x: number;
    y1: number;
    y2: number;
    w?: number;
    h?: number;
    color?: string;
    opacity?: number;
}>;
export declare const PacketDot: React.FC<{
    x: number;
    yFrom: number;
    yTo: number;
    t: number;
    label?: string;
    color?: string;
}>;
export declare const BounceCounter: React.FC<{
    n: number;
    x: number;
    y: number;
    opacity?: number;
}>;
export declare const Padlock: React.FC<{
    x: number;
    y: number;
    progress: number;
    closed?: boolean;
    size?: number;
}>;
export declare const PaintReveal: React.FC<{
    progress: number;
    width: number;
    height: number;
    wire: React.ReactNode;
    color: React.ReactNode;
}>;
export declare const DomNodes: React.FC<{
    frame: number;
    at: number;
    stagger?: number;
    opacity?: number;
}>;
