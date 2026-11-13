import React from 'react';
import type { Enter } from './collage';
export declare const CONTAINER_COLORS: {
    readonly docker: "#2b7fc4";
    readonly red: "#c0492b";
    readonly teal: "#33695d";
    readonly yellow: "#e8b73a";
    readonly steel: "#7c8590";
};
export declare const PropLayer: React.FC<{
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
    children: React.ReactNode;
}>;
export declare const LaptopSvg: React.FC<{
    state?: 'code' | 'ok' | 'err';
}>;
export declare const ServerRackSvg: React.FC<{
    err?: boolean;
}>;
export declare const ContainerSvg: React.FC<{
    color?: string;
    label?: string;
    sub?: string;
}>;
export declare const CargoShipSvg: React.FC;
export declare const CloudSvg: React.FC;
export declare const StatusBadge: React.FC<{
    kind: 'ok' | 'err';
    x: number;
    y: number;
    r?: number;
    at?: number;
    depth?: number;
    z?: number;
}>;
export type StackBlock = {
    label: string;
    color: string;
    textColor?: string;
    h?: number;
};
export declare const LayerStack: React.FC<{
    blocks: StackBlock[];
    x: number;
    y: number;
    w: number;
    at?: number;
    stagger?: number;
    depth?: number;
}>;
