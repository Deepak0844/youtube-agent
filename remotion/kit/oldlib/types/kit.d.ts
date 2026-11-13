import React from 'react';
export declare const CLAMP: {
    extrapolateLeft: "clamp";
    extrapolateRight: "clamp";
};
export declare const lib: (name: string) => string;
export declare const BrandBg: React.FC<{
    glow?: string;
}>;
export declare const useRise: () => (start: number, dist?: number, dur?: number) => {
    opacity: number;
    transform: string;
};
export declare const Sunburst: React.FC<{
    size: number;
    color?: string;
}>;
export declare const ClaudeCodePromptShot: React.FC<{
    prompt: string;
    cwd?: string;
    responseLabel?: string;
    typeStart?: number;
    perChar?: number;
}>;
export declare const LevelTitleShot: React.FC<{
    n: string;
    title: string;
    subtitle: string;
    color: string;
}>;
export declare const ImageRevealShot: React.FC<{
    src: string;
    tag: string;
    title: string;
    subtitle?: string;
    color: string;
    boxW?: number;
    boxH?: number;
}>;
export declare const V: {
    readonly chrome: "#181818";
    readonly editor: "#1e1e1e";
    readonly sidebar: "#181818";
    readonly border: "#2b2b2b";
    readonly text: "#cccccc";
    readonly dim: "#8b8b8b";
    readonly faint: "#6e6e6e";
    readonly blue: "#3794ff";
    readonly green: "#4ec98f";
    readonly coral: "#cd8064";
    readonly input: "#242424";
    readonly inputBorder: "#3a3a3a";
};
export declare const VSC: {
    readonly TITLE_H: 44;
    readonly ACT_W: 54;
    readonly SB_X: 54;
    readonly SB_W: 372;
    readonly ED_X: 426;
    readonly ED_W: 1494;
    readonly ED_CX: number;
};
export declare const VSCodeShell: React.FC<{
    children?: React.ReactNode;
    tab?: string;
}>;
export declare const ClaudeChatPanel: React.FC<{
    prompt: string;
    responseLabel?: string;
    typeStart?: number;
    perChar?: number;
    region?: {
        x: number;
        w: number;
    };
    emptyText?: React.ReactNode;
    renderResponse?: (ctx: {
        frame: number;
        send: number;
        spin: number;
        r: (a: number, b: number, from?: number, to?: number) => number;
    }) => React.ReactNode;
}>;
