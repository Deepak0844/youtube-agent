import React, { useContext, useLayoutEffect, useRef } from "react";
import { ToonContext, type ToonCharacter } from "./context";
import { useSceneId } from "./scene-parts";
import { useRuntime, useToon, useToonBuild } from "./Stage";

// yt-toon/anime: the anime look of cartoon-shorts (styles/anime.js): cel-shaded busts with big eyes and the effects of anime (focus lines,
// sparkles, bokeh, screentone, blur, grain). A Bust is redrawn every frame from `act(t)`, so a face can change with every beat.

export type AnimeLook = Record<string, string | number | boolean | null>;
/** Face of one moment (every field optional). eyes: open | wide | happy | closed; mouth: smile | soft | line | frown | grin | open | shout; look [x, y] -1..1; lid, brow, browY, open, tears, wet, blush, turn, tilt, shine; sweat. */
export type AnimeExpression = {
  eyes?: "open" | "wide" | "happy" | "closed";
  look?: [number, number];
  lid?: number;
  brow?: number;
  browY?: number;
  mouth?: "smile" | "soft" | "line" | "frown" | "grin" | "open" | "shout";
  open?: number;
  tears?: number;
  blush?: number;
  sweat?: boolean;
  turn?: number;
  tilt?: number;
  wet?: number;
  shine?: number;
};
/** Where the bust is and what its face does: (x, y) is the eye line, `s` the scale (1 = head about 360 units tall), `ex` the expression. */
export type BustFrame = { x: number; y: number; s: number; ex?: AnimeExpression };

/* eslint-disable @typescript-eslint/no-explicit-any */
// Long hair with bangs (hairStyle "long"): cartoon-shorts' own example subclasses the bust and replaces the three hair hooks.
const BANGS: number[][] = [];
{
  const tips = [[-102, -84], [-58, -76], [-16, -82], [24, -92], [66, -76], [106, -82]];
  const notch = [[-82, -116], [-38, -126], [4, -134], [46, -126], [88, -118]];
  tips.forEach(([x, y], i) => {
    BANGS.push([x!, y!, 1, 1]);
    const n = notch[i];
    if (!n) return;
    BANGS.push([x! + 2, n[1]! + 8], [n[0]!, n[1]!, 1], [tips[i + 1]![0]! - 2, n[1]! + 8]);
  });
}
function makeGirl(A: any): any {
  const { curvy, clip, P } = A.FX;
  const E = A.E;
  const INK = A.INK;
  return class Girl extends A.Bust {
    hairBack(g: Element, o: any) {
      const R = [[0, -250], [96, -238], [158, -170], [172, -40], [176, 120], [196, 260], [212, 364, 1], [170, 334], [150, 374, 1], [118, 332], [88, 356, 1], [72, 250], [66, 140]];
      const pts = R.concat([[0, 100]], R.slice(1).reverse().map(([x, y, s]) => [-x!, y!, s!]));
      const d = curvy(pts);
      E("path", { d, fill: o.hair, stroke: INK, "stroke-width": 3.5, "stroke-linejoin": "round" }, g);
      const hc = E("g", { "clip-path": clip(g, d) }, g);
      E("path", { d: "M 60 -300 C 150 -200 190 60 150 420 L 260 420 L 260 -300 Z", fill: o.hairS, opacity: 0.55 }, hc);
      E("path", { d: "M -150 160 C -160 240 -150 300 -130 350 M 140 170 C 150 240 150 300 136 350", fill: "none", stroke: o.hairS, "stroke-width": 5, "stroke-linecap": "round" }, hc);
    }
    foreheadShadow(fc: Element, o: any) {
      const d = "M -130 -40 " + BANGS.map(([x, y]) => `L ${x! + 6} ${y! + 18}`).join(" ") + " L 130 -40 L 130 -280 L -130 -280 Z";
      E("path", { d, fill: o.skinS }, fc);
    }
    hairFront(g: Element, o: any) {
      const pts = ([[-112, 132, 1], [-128, 40], [-138, -60], [-142, -150], [-104, -226], [-40, -258], [0, -262], [40, -258], [104, -226], [142, -150], [138, -60], [128, 40], [112, 132, 1], [106, 60], [112, -30]] as number[][]).concat(BANGS.slice().reverse(), [[-112, -30], [-106, 60]]);
      const d = curvy(pts);
      E("path", { d, fill: o.hair, stroke: INK, "stroke-width": 3.5, "stroke-linejoin": "round" }, g);
      const hc = E("g", { "clip-path": clip(g, d) }, g);
      E("path", { d: "M 50 -300 C 130 -250 160 -120 150 140 L 240 140 L 240 -300 Z", fill: o.hairS, opacity: 0.5 }, hc);
      BANGS.filter((p) => p[3]).forEach(([x, y]) => E("path", { d: P("M", x! * 0.15, -252, "Q", x! * 0.7, -190, x, y! + 6), fill: "none", stroke: INK, "stroke-width": 2.2, opacity: 0.4 }, hc));
      // the shiny "angel ring" highlight across the crown: a thin arc with a toothed lower edge
      let ring = "M -112 -188";
      for (let x = -112; x <= 112; x += 8) ring += ` L ${x} ${(-188 - 44 * (1 - (x / 112) ** 2)).toFixed(1)}`;
      for (let x = 112, k = 0; x >= -112; x -= 14, k++) ring += ` L ${x} ${(-188 - 44 * (1 - (x / 112) ** 2) + (k % 2 ? 22 : 10)).toFixed(1)}`;
      E("path", { d: ring + " Z", fill: o.hairH, opacity: 0.9 }, hc);
    }
  };
}

/**
 * An anime bust, drawn again for every frame from `act(t)`. `look` is the one-off look (skin, hair, hairStyle spiky | swept | buzz | long, iris,
 * eyeW, eyeH, eyeGap, lash, jaw, glasses, outfit kit | suit, shirt, tie, ...); `who` takes the look from the series cast.
 */
export const Bust: React.FC<{ who?: string; look?: AnimeLook; act: (t: number) => BustFrame }> = ({ who, look, act }) => {
  const rt = useRuntime();
  const input = useContext(ToonContext);
  const id = useSceneId();
  const ref = useRef<SVGGElement>(null);
  const actRef = useRef(act);
  useLayoutEffect(() => {
    actRef.current = act;
  });
  useToonBuild(() => {
    const member: ToonCharacter | undefined = who ? input?.cast.find((c) => c.name === who) : undefined;
    if (who && !member && !look) throw new Error(`cast: '${who}' is not in the cast (${(input?.cast ?? []).map((c) => c.name).join(", ") || "empty"})`);
    const opts = { ...(member?.options ?? {}), ...(look ?? {}) };
    const A = rt.win.Anime;
    const Cls = opts.hairStyle === "long" ? makeGirl(A) : A.Bust;
    const bust = new Cls(ref.current, opts);
    const info = rt.short.sceneById[id];
    let made: Element[] = [];
    // draw() adds gradients and clip paths to <defs> on every call: drop the ones the last frame made
    rt.short.ups.push((t: number) => {
      if (!info || t < info.start || t >= info.end) return;
      const defs = (ref.current as SVGGElement).ownerSVGElement!.querySelector("defs")!;
      made.forEach((d) => d.remove());
      const before = new Set(Array.from(defs.children));
      const f = actRef.current(t);
      bust.draw(f.x, f.y, f.s, f.ex ?? {});
      made = Array.from(defs.children).filter((d) => !before.has(d));
    });
  });
  return <g ref={ref} />;
};

type Mark = string | number;
function piece<P extends object>(fn: string, args: (keyof P & string)[]): React.FC<P> {
  const C: React.FC<P> = (props) => {
    const ref = useRef<SVGGElement>(null);
    const rt = useRuntime();
    useToonBuild(() => {
      rt.win.Anime.FX[fn](ref.current, ...args.map((n) => (props as Record<string, unknown>)[n]));
    });
    return <g ref={ref} />;
  };
  C.displayName = fn;
  return C;
}

const SpeedLinesBase = piece<{ cx: number; cy: number; r0: number; r1: number; n: number; color?: string; op?: number; seed?: number }>("speedLines", ["cx", "cy", "r0", "r1", "n", "color", "op", "seed"]);
/** Focus lines aimed at (cx, cy), the classic anime impact background; `spin` turns them slowly (degrees per second, negative = the other way). */
export const SpeedLines: React.FC<{ cx: number; cy: number; r0: number; r1: number; n: number; color?: string; op?: number; seed?: number; spin?: number }> = ({ spin, ...p }) => {
  const { t } = useToon();
  return (
    <g transform={spin ? `rotate(${(t * spin).toFixed(2)} ${p.cx} ${p.cy})` : undefined}>
      <SpeedLinesBase {...p} />
    </g>
  );
};
/** Parallel motion streaks in a box (x, y, w, h) turned by `ang` degrees. */
export const Streaks = piece<{ x: number; y: number; w: number; h: number; n: number; ang: number; color?: string; op?: number; seed?: number }>("streaks", ["x", "y", "w", "h", "n", "ang", "color", "op", "seed"]);
/** Four-point star. Draw it at radius 1 inside a <g transform=...> to animate it. */
export const Sparkle = piece<{ x: number; y: number; r: number; color?: string; op?: number }>("sparkle", ["x", "y", "r", "color", "op"]);
/** A soft circle of light with its own radial gradient; wrap it in a <g transform=...> to move it. */
export const Bokeh = piece<{ x: number; y: number; r: number; color: string; op?: number }>("bokeh", ["x", "y", "r", "color", "op"]);
/** A 1080 x 1920 film-grain noise layer. */
export const Grain = piece<{ op?: number }>("grain", ["op"]);
/** A gaussian blur filter with this id: filter="url(#id)" on a group blurs it. */
export const BlurFilter: React.FC<{ id: string; sd: number }> = ({ id, sd }) => (
  <filter id={id} x="-20%" y="-20%" width="140%" height="140%">
    <feGaussianBlur stdDeviation={sd} />
  </filter>
);
export type { Mark };

/** cartoon-shorts' seeded random numbers: const R = rng(21); R() gives the same 0..1 sequence every time. */
export const rng = (seed: number): (() => number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
