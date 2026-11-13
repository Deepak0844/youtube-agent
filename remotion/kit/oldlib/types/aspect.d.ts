import React from 'react';
export declare const SRC_W = 1080;
export declare const SRC_H = 1920;
export declare const RATIOS: {
    readonly '16x9': {
        readonly width: 1920;
        readonly height: 1080;
    };
    readonly '1x1': {
        readonly width: 1080;
        readonly height: 1080;
    };
};
export type RatioKey = keyof typeof RATIOS;
export declare const AspectFrame: React.FC<{
    Comp: React.FC;
    blur?: number;
}>;
