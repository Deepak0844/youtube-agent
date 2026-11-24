import React from "react";
export type PoseName = "stand" | "ready" | "shoot" | "release" | "block" | "leap" | "layup" | "dunk" | "kneel" | "kneelFace" | "kneelRoar" | "roar" | "flex" | "celebrate" | "sit" | "sitSad" | "carry" | "cradle" | "reach" | "point" | "hold" | "write" | "trophy";
export type FaceName = "neutral" | "focus" | "grit" | "shout" | "roar" | "sad" | "cry" | "smile" | "grin" | "wow" | "worry";
/** Joint angles (degrees) and face of one moment: tor (lean), hd (head tilt), nua/nfa near upper/fore-arm, fua/ffa far, nth/nsh near thigh/shin, fth/fsh far, nft/fft feet, turn (0 side .. 1 front), lift, look, blink, tears, open; face; hand/fhand: "fist" | "open". */
export type Pose = Partial<Record<"tor" | "hd" | "nua" | "nfa" | "fua" | "ffa" | "nth" | "nsh" | "fth" | "fsh" | "nft" | "fft" | "turn" | "lift" | "look" | "blink" | "tears" | "sq" | "open", number>> & {
    face?: FaceName;
    hand?: "fist" | "open";
    fhand?: "fist" | "open";
};
/** Ready-made poses by name. */
export declare const P: Record<PoseName, Pose>;
/** Blend two poses: mix(P.stand, P.point, 0.5). */
export declare const mix: (a: Pose, b: Pose, k: number) => Pose;
/** Walk / run / sprint cycle pose for a phase in radians. */
export declare const cycle: (phase: number, amp?: number, kind?: "run" | "walk" | "sprint") => Pose;
/** A value that moves through keys [[seconds, value, ease?], ...] (numbers, arrays or poses). */
export declare const track: <V>(keys: [number, V, string?][]) => (t: number) => V;
export declare const EASE: Record<string, (x: number) => number>;
/** Where a puppet is and how it stands at one moment. `dir` -1 faces left; `s` is the scale. */
export type PuppetFrame = {
    pose: Pose;
    x: number;
    y: number;
    dir?: 1 | -1;
    s?: number;
};
export type PuppetOptions = Record<string, string | number | boolean | null>;
/** A thing the puppet holds or wears at a joint: an SVG child moved with it (e.g. a phone in the hand). `at` is a joint name: hand, fhand, head, neck, hip, foot, ffoot, knee, elbow, shoulder. */
export type Held = {
    at: "hand" | "fhand" | "head" | "neck" | "hip" | "foot" | "ffoot" | "knee" | "elbow" | "shoulder" | "fshoulder";
    dx?: number;
    dy?: number;
    s?: number;
    r?: number | ((t: number) => number);
    /** Full control: where the held piece goes for time t, given the joint's position: [x, y, scale, rotation]. Replaces dx, dy, s and r. */
    place?: (t: number, joint: [number, number]) => [number, number, number, number];
    node: React.ReactNode;
};
/**
 * One character. `who` takes the look from the series cast (ref/cast.json); `options` is a one-off look (or overrides): the puppet
 * options of cartoon-shorts (skin, skinD, hair, hairStyle, top, shirt, shirtD, tie, pants, shoe, beard, cap, glasses, kid, build...).
 */
export declare const Puppet: React.FC<{
    who?: string;
    options?: PuppetOptions;
    act: (t: number) => PuppetFrame;
    held?: Held[];
}>;
