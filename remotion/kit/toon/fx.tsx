import React, { useRef } from "react";
import { sceneParts, useSceneId } from "./scene-parts";
import { useRuntime, useToonBuild } from "./Stage";

// yt-toon/fx: the set pieces of cartoon-shorts (styles/fx.js), one component each. The drawing is cartoon-shorts' own code; props are its
// arguments by name. Positions are stage units (portrait 1080 x 1920). `a`/`b` are marks. Every piece draws into its own <g>, in the order
// you write them (later pieces are on top).

type Mark = string | number;
type Piece<P> = React.FC<P>;

/** Makes a component that calls FX[fn](g, ...args in this order) once, when the film is built. */
function piece<P extends object>(fn: string, args: (keyof P & string)[]): Piece<P> {
  const C: Piece<P> = (props) => {
    const ref = useRef<SVGGElement>(null);
    const rt = useRuntime();
    useToonBuild(() => {
      rt.FX[fn](ref.current, ...args.map((n) => (props as Record<string, unknown>)[n]));
    });
    return <g ref={ref} />;
  };
  C.displayName = fn;
  return C;
}

export const Rays = piece<{ cx: number; cy: number; n: number; color: string; op?: number; speed?: number; r?: number }>("rays", ["cx", "cy", "n", "color", "op", "speed", "r"]);
/** Comic explosion star. */
export const Burst = piece<{ cx: number; cy: number; r1: number; r2: number; n: number; fill: string; stroke?: string; sw?: number; seed?: number }>("burst", ["cx", "cy", "r1", "r2", "n", "fill", "stroke", "sw", "seed"]);
export const SpeedLines = piece<{ cx: number; cy: number; rIn: number; rOut: number; n: number; color: string; a: Mark; b: Mark; w?: number }>("speed", ["cx", "cy", "rIn", "rOut", "n", "color", "a", "b", "w"]);
export const Streaks = piece<{ x0: number; x1: number; y0: number; y1: number; n: number; color: string; a: Mark; b: Mark; speed?: number }>("streaks", ["x0", "x1", "y0", "y1", "n", "color", "a", "b", "speed"]);
export const Confetti = piece<{ a: Mark; b: Mark; colors: string[]; n?: number; x0?: number; x1?: number; y0?: number; fall?: number; seed?: number }>("confetti", ["a", "b", "colors", "n", "x0", "x1", "y0", "fall", "seed"]);
export const Flames = piece<{ cx: number; base: number; w: number; h: number; a: Mark; b: Mark }>("flames", ["cx", "base", "w", "h", "a", "b"]);
export const Rain = piece<{ a: Mark; b: Mark; n?: number; color?: string; seed?: number }>("rain", ["a", "b", "n", "color", "seed"]);
/** Arena crowd; `excite` is a number 0..1 or a function of time. */
export const Crowd = piece<{ x0: number; x1: number; y0: number; rows: number; a: Mark; b: Mark; excite?: number | ((t: number) => number); seed?: number; dark?: number; palette?: string[] | null }>("crowd", ["x0", "x1", "y0", "rows", "a", "b", "excite", "seed", "dark", "palette"]);
export const Stars = piece<{ n: number; w: number; h: number; seed?: number; op?: number }>("stars", ["n", "w", "h", "seed", "op"]);
export const Skyline = piece<{ x0: number; x1: number; base: number; color: string; seed?: number; hmin?: number; hmax?: number; lit?: string }>("skyline", ["x0", "x1", "base", "color", "seed", "hmin", "hmax", "lit"]);
export const House = piece<{ x: number; y: number; w: number; h: number; wall: string; roof: string; lit?: boolean }>("house", ["x", "y", "w", "h", "wall", "roof", "lit"]);
export const Palm = piece<{ x: number; y: number; s?: number; color?: string }>("palm", ["x", "y", "s", "color"]);
export const Trophy = piece<{ x: number; y: number; s?: number }>("trophy", ["x", "y", "s"]);
export const Ring = piece<{ x: number; y: number; s?: number; label?: string }>("ring", ["x", "y", "s", "label"]);
export const Jersey = piece<{ x: number; y: number; s: number; color: string; trim: string; num: string; numFill?: string; sleeves?: boolean }>("jersey", ["x", "y", "s", "color", "trim", "num", "numFill", "sleeves"]);
export const Box = piece<{ x: number; y: number; w: number; h: number; label?: string }>("box", ["x", "y", "w", "h", "label"]);
export const Desk = piece<{ x: number; y: number; s?: number; color?: string }>("desk", ["x", "y", "s", "color"]);
export const Football = piece<{ x: number; y: number; s?: number; rot?: number }>("football", ["x", "y", "s", "rot"]);
export const School = piece<{ x: number; y: number; s?: number }>("school", ["x", "y", "s"]);

/** Street lamp with its light cone (uses the scene's gradients). */
export const Streetlight: Piece<{ x: number; y: number; h?: number; glow?: string }> = ({ x, y, h, glow }) => {
  const ref = useRef<SVGGElement>(null);
  const rt = useRuntime();
  const id = useSceneId();
  useToonBuild(() => rt.FX.streetlight(ref.current, x, y, h, glow, sceneParts(id).svg));
  return <g ref={ref} />;
};
/** Side view of a court floor. */
export const Court: Piece<{ x0: number; x1: number; y: number; h?: number }> = ({ x0, x1, y, h }) => {
  const ref = useRef<SVGGElement>(null);
  const rt = useRuntime();
  const id = useSceneId();
  useToonBuild(() => rt.FX.court(sceneParts(id).svg, ref.current, x0, x1, y, h));
  return <g ref={ref} />;
};
/** A hoop; `net` gives the net's swing 0..1 for a time (0 = rest). */
export const Hoop: Piece<{ x: number; y: number; s?: number; flip?: boolean; net?: (t: number) => number }> = ({ x, y, s, flip, net }) => {
  const ref = useRef<SVGGElement>(null);
  const rt = useRuntime();
  useToonBuild(() => {
    const h = rt.FX.hoop(ref.current, x, y, s, flip);
    if (net) rt.short.ups.push((t: number) => h.setNet(net(t)));
  });
  return <g ref={ref} />;
};
/** Springy pop-in of its children at a mark, scaled around (cx, cy). */
export const PopIn: Piece<{ at: Mark; dur?: number; cx?: number; cy?: number; from?: number; children?: React.ReactNode }> = ({ at, dur, cx, cy, from, children }) => {
  const ref = useRef<SVGGElement>(null);
  const rt = useRuntime();
  useToonBuild(() => rt.FX.popIn(ref.current, at, dur, cx, cy, from));
  return <g ref={ref}>{children}</g>;
};
/** A camera rig: its children are moved so the view looks at (cx, cy) with zoom and rotation between keys [[mark, cx, cy, zoom?, rot?, ease?], ...]. */
export const CamRig: Piece<{ keys: [Mark, number, number, number?, number?, string?][]; fx?: number; fy?: number; children?: React.ReactNode }> = ({ keys, fx, fy, children }) => {
  const ref = useRef<SVGGElement>(null);
  const rt = useRuntime();
  useToonBuild(() => rt.FX.cam(ref.current, keys, fx, fy));
  return <g ref={ref}>{children}</g>;
};
