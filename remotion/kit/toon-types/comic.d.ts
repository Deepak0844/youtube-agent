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
/** Pose `over` on top of pose `base`: pose(P.stand, { face: "grin" }). */
export declare const pose: (base: Pose, over: Pose) => Pose;
/** Where a puppet is and how it stands at one moment. `dir` -1 faces left; `s` is the scale. */
export type PuppetFrame = {
    pose: Pose;
    x: number;
    y: number;
    dir?: 1 | -1;
    s?: number;
};
export type PuppetOptions = Record<string, string | number | boolean | null>;
/** Joint names a puppet can report: hand, fhand (far hand), head, neck, hip, foot, ffoot, knee, elbow, shoulder, fshoulder. */
export type Joint = "hand" | "fhand" | "head" | "neck" | "hip" | "foot" | "ffoot" | "knee" | "elbow" | "shoulder" | "fshoulder";
/**
 * One character. `who` takes the look from the series cast (ref/cast.json); `options` is a one-off look (or overrides): the puppet
 * options of cartoon-shorts (skin, skinD, hair, hairStyle, top, shirt, shirtD, tie, pants, shoe, beard, cap, glasses, kid, build...).
 * `id` lets a <Follow> hold a prop at one of its joints.
 */
export declare const Puppet: React.FC<{
    id?: string;
    who?: string;
    options?: PuppetOptions;
    act: (t: number) => PuppetFrame;
}>;
/**
 * Holds its children (a phone, a cup, a letter) at a joint of the puppet with this `id`, drawn where you write it (so put it after
 * the puppet, and after anything that should cover the prop's z-order). `place` gives where it goes at time t: [x, y, scale, rotation].
 * Show or hide the children yourself (style display) for the times the prop is not in hand.
 */
export declare const Follow: React.FC<{
    of: string;
    at?: Joint;
    dx?: number;
    dy?: number;
    s?: number;
    r?: number;
    place?: (t: number, joint: [number, number]) => [number, number, number, number];
    children?: React.ReactNode;
}>;
