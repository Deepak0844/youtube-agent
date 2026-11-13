import React from 'react';
import { Country, Ring } from './geo/world';
export type { Country, Ring };
export declare const MAX_LAT = 85.05;
export declare const mercY: (lat: number) => number;
export type MapScale = {
    px: (lon: number, lat: number) => [number, number];
    box: {
        x: number;
        y: number;
        w: number;
        h: number;
    };
    k: number;
};
export declare const makeMapScale: (lonRange: [number, number], latRange: [number, number], box: {
    x: number;
    y: number;
    w: number;
}) => MapScale;
export type Move = {
    toLon: number;
    toLat: number;
};
export declare const countryPath: (s: MapScale, c: Country) => string;
export declare const movedPath: (s: MapScale, c: Country, m: Move, t: number) => string;
export declare const movedCentroid: (c: Country, m: Move, t: number) => [number, number];
export declare const projectedArea: (s: MapScale, c: Country, m?: Move, t?: number) => number;
export declare const inflation: (s: MapScale, c: Country) => number;
export declare const centroid: (c: Country) => [number, number];
export declare const WorldLayer: React.FC<{
    scale: MapScale;
    except?: string[];
    fill?: string;
    stroke?: string;
    opacity?: number;
}>;
export declare const CountryShape: React.FC<{
    scale: MapScale;
    country: Country;
    move?: Move;
    t?: number;
    fill: string;
    stroke?: string;
    strokeWidth?: number;
    opacity?: number;
    glow?: boolean;
}>;
export declare const Graticule: React.FC<{
    scale: MapScale;
    lats?: number[];
    color?: string;
    opacity?: number;
}>;
export declare const MapLabel: React.FC<{
    x: number;
    y: number;
    title: string;
    stat?: string;
    color: string;
    size?: number;
    opacity?: number;
    scaleUp?: number;
    anchor?: 'middle' | 'start' | 'end';
}>;
