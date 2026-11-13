import React from 'react';
export declare const EL: {
    gold: string;
    cyan: string;
    blue: string;
    red: string;
    copper: string;
    indigo: string;
    steelHi: string;
    steelLo: string;
    night: string;
};
export declare const ElectricDefs: React.FC;
export declare const polyAt: (pts: [number, number][], u: number) => [number, number];
export declare const Cable: React.FC<{
    pts: [number, number][];
    phase: number;
    color?: string;
    width?: number;
    n?: number;
    opacity?: number;
    pulse?: number;
}>;
export declare const Bulb: React.FC<{
    cx: number;
    cy: number;
    s?: number;
    glow?: number;
}>;
export declare const Turbine: React.FC<{
    cx: number;
    cy: number;
    r: number;
    rot: number;
    glow?: number;
    blur?: number;
}>;
export declare const MagnetCoil: React.FC<{
    cx: number;
    cy: number;
    ang: number;
    flow: number;
    flowOn: number;
    needle: number;
    fieldOn: number;
}>;
export declare const Boiler: React.FC<{
    cx: number;
    cy: number;
    w: number;
    t: number;
    fire?: number;
}>;
export declare const WindTurbine: React.FC<{
    x: number;
    baseY: number;
    h: number;
    rot: number;
}>;
export declare const Dam: React.FC<{
    x: number;
    y: number;
    t: number;
    rot: number;
}>;
export declare const SolarPanel: React.FC<{
    cx: number;
    cy: number;
    w: number;
    lit: number;
    beams: number;
    flow: number;
    t: number;
}>;
export declare const Pylon: React.FC<{
    x: number;
    baseY: number;
    h: number;
}>;
export declare const Donut: React.FC<{
    cx: number;
    cy: number;
    r: number;
    pct: number;
    label: string;
}>;
