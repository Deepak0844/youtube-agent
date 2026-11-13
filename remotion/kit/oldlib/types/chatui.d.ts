import React from 'react';
import { EASE_OUT, prog } from './shorts';
export type Bubble = {
    text: string;
    from: 'user' | 'ai';
};
export declare const PhoneShell: React.FC<{
    x: number;
    y: number;
    w: number;
    h: number;
    headerH: number;
    title?: string;
    children: React.ReactNode;
}>;
export declare const ScrollTrack: React.FC<{
    x: number;
    y: number;
    h: number;
    thumbFrac?: number;
    thumbSize?: number;
}>;
export declare const ChatBubble: React.FC<{
    text: string;
    from: 'user' | 'ai';
    x: number;
    y: number;
    w: number;
    h: number;
    opacity?: number;
    highlight?: number;
    fontSize?: number;
}>;
export declare const resendHighlight: (frame: number, rank: number, pulses: number[], staggerF?: number, riseF?: number, fallF?: number) => number;
export declare const WindowFrame: React.FC<{
    x: number;
    y: number;
    w: number;
    h: number;
    color?: string;
    labelText?: string;
    labelColor?: string;
    labelOpacity?: number;
}>;
export declare const TokenStrip: React.FC<{
    x: number;
    y: number;
    w: number;
    cellCount?: number;
    tickFrames: number[];
    dimAt?: number;
    dimBandCells?: number;
    opacity?: number;
    color?: string;
}>;
export declare const MiniChatPanel: React.FC<{
    x: number;
    y: number;
    w: number;
    h: number;
    title: string;
    color: string;
    rows: {
        text: string;
        from: 'user' | 'ai';
        faded?: boolean;
    }[];
    opacity?: number;
}>;
export { EASE_OUT, prog };
