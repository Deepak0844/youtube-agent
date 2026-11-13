import React from 'react';
export declare const GM = 398600441800000;
export declare const R_EARTH = 6371000;
export declare const ISS_ALT = 400000;
/** Gravitational acceleration at radius r (from Earth's CENTRE, not the ground). */
export declare const gAt: (r: number) => number;
/** Speed of a circular orbit at radius r. */
export declare const vCirc: (r: number) => number;
/** Escape speed at radius r. */
export declare const vEsc: (r: number) => number;
/** Period of a circular orbit at radius r, seconds. */
export declare const period: (r: number) => number;
/**
 * How far a sphere of radius r "curves away" from the straight line tangent to it, over an
 * arc of length d. This is the sagitta, r·(1 − cos(d/r)).
 *
 * NOTE, because it is the whole video and it is easy to get wrong: for something in orbit at
 * 400 km, "the Earth curving away beneath it" is the curvature of the SHELL IT IS ON
 * (r = R + h), not of the ground (r = R). The ground, being more sharply curved, drops 4.62 m
 * over a 7.67 km chord — but the distance from the station to the ground is what must stay
 * constant, and that is governed by r = R + h, which drops 4.35 m. That 4.35 equals the 4.35 m
 * the station falls in the same second — necessarily, because that equality IS what a circular
 * orbit is. We show the shell number, because the shell number is the one that is exactly true.
 */
export declare const sagitta: (r: number, d: number) => number;
export type Vec = [number, number];
export type Traj = {
    pts: Vec[];
    impact: boolean;
    tEnd: number;
    downrangeDeg: number;
    downrangeKm: number;
    apoKm: number;
    periKm: number;
};
/**
 * Fire a ball from `r0` metres out (measured from Earth's centre), starting at the top of the
 * screen, horizontally to the right at `v0` m/s. Integrate until it hits the ground or `maxT`
 * seconds elapse.
 */
export declare const integrate: (r0: number, v0: number, maxT: number, dt?: number) => Traj;
export type View = {
    cx: number;
    cy: number;
    rPx: number;
    m2px: number;
    px: (p: Vec) => Vec;
};
export declare const makeView: (cx: number, cy: number, rPx: number) => View;
/** Point on the trajectory at fraction `t` (0..1) of its flight, linearly between samples. */
export declare const trajPoint: (tr: Traj, t: number) => Vec;
/** SVG path for the first `t` (0..1) of the flight — the arc drawing itself as the ball flies. */
export declare const trajPath: (v: View, tr: Traj, t?: number) => string;
export declare const Globe: React.FC<{
    view: View;
    lon0?: number;
    lat0?: number;
    ocean?: string;
    land?: string;
    landStroke?: string;
    terminator?: boolean;
}>;
/** The thin skin of air. To scale — and the fact that it looks like nothing is the point. */
export declare const Atmosphere: React.FC<{
    view: View;
    km?: number;
    color?: string;
    opacity?: number;
}>;
export declare const Trajectory: React.FC<{
    view: View;
    traj: Traj;
    t?: number;
    color: string;
    width?: number;
    opacity?: number;
    dashed?: boolean;
    ball?: boolean;
    ballR?: number;
    glow?: boolean;
}>;
/**
 * Where it came down. `scale` compensates for a camera zoom on the parent <g>: pass 1/z and the
 * marker stays the same size on screen while the planet under it grows.
 */
export declare const Impact: React.FC<{
    view: View;
    traj: Traj;
    color: string;
    opacity?: number;
    scale?: number;
}>;
/** The tower Newton fires from — here, 400 km tall, i.e. exactly the station's altitude. */
export declare const Cannon: React.FC<{
    view: View;
    altM: number;
    color?: string;
    opacity?: number;
    scale?: number;
}>;
/** The station on its orbit, at angle `deg` measured clockwise from straight up. */
export declare const satPos: (view: View, altM: number, deg: number) => Vec;
export declare const Sat: React.FC<{
    view: View;
    altM: number;
    deg: number;
    color?: string;
    scale?: number;
    opacity?: number;
}>;
/** The arrow that is the whole thesis: it points DOWN. Down is toward the centre. */
export declare const GravityArrow: React.FC<{
    view: View;
    from: Vec;
    lenPx?: number;
    color?: string;
    label?: string;
    opacity?: number;
    width?: number;
}>;
/** The speed ladder: each rung lights as the narrator names it. */
export declare const SpeedLadder: React.FC<{
    rungs: {
        v: string;
        note: string;
        on: number;
    }[];
    x?: number;
    y?: number;
    color?: string;
    hit?: string;
    opacity?: number;
}>;
/**
 * THE PAYOFF PANEL — two quantities and an equals sign between them. Used for the moment the
 * video exists to deliver: it falls 4.35 m, the Earth curves away 4.35 m. Both numbers are
 * passed in already computed, so the "=" is earned by the physics, not asserted by a designer.
 */
export declare const EqualityPanel: React.FC<{
    left: {
        label: string;
        value: string;
    };
    right: {
        label: string;
        value: string;
    };
    x?: number;
    y?: number;
    w?: number;
    color?: string;
    opacity?: number;
    rightOp?: number;
    eq?: number;
    foot?: string;
    footOp?: number;
}>;
