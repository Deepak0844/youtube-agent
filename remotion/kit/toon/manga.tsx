import React, { useRef } from "react";
import { makeBust } from "./bust";
import { rng } from "./anime";
import { useRuntime, useToon, useToonBuild } from "./Stage";

// yt-toon/manga: the manga look of cartoon-shorts (styles/manga.js): thick ink, small round pupils, chunky brows, strong noses and jaws, huge
// toothy grins, fountain tears and hatching. Same idea as yt-toon/anime: a Bust is redrawn every frame from `act(t)`. Backgrounds and effects
// (SpeedLines, Sparkle, Bokeh, Streaks, DotsPattern from yt-toon/core, LinGrad, RadGrad) come from the other modules.

const MANGA_INK = "#151214";

/**
 * Look options: head (lean | square | round), nose (small | long | wide), hairStyle (spiky | swept | buzz), skin, skinS, hair, hairS, hairH, eyeW, eyeH,
 * eyeGap, pupil, mouthW, age, glasses, frame, stubble, outfit (kit | suit), shirt, shirtS, trim, suit, suitS, tie, collar. `headband` (a colour) adds a
 * tied headband that follows the head.
 */
export type MangaLook = Record<string, string | number | boolean | null>;
/** Face of one moment. eyes: open | happy | closed | wide | fierce; mouth: smile | smirk | line | frown | grin | shout | cry; look [x, y] -1..1; lid, brow, open, tears (+ fountain), blush, sweat, shade, glare, turn, tilt. */
export type MangaExpression = {
  eyes?: "open" | "happy" | "closed" | "wide" | "fierce";
  look?: [number, number];
  lid?: number;
  brow?: number;
  mouth?: "smile" | "smirk" | "line" | "frown" | "grin" | "shout" | "cry";
  open?: number;
  tears?: number;
  fountain?: boolean;
  blush?: number;
  sweat?: boolean;
  shade?: number;
  glare?: boolean;
  turn?: number;
  tilt?: number;
};
export type MangaBustFrame = { x: number; y: number; s: number; ex?: MangaExpression };

/* eslint-disable @typescript-eslint/no-explicit-any */
// the headband of cartoon-shorts' manga example, drawn in head units on the bust's own group so it follows tilt and scale
const NS = "http://www.w3.org/2000/svg";
function addBand(bust: any, opts: Record<string, any>) {
  if (!opts.headband) return;
  const path = (d: string, sw: number) => {
    const el = document.createElementNS(NS, "path");
    for (const [k, v] of Object.entries({ d, fill: opts.headband, stroke: MANGA_INK, "stroke-width": sw, "stroke-linejoin": "round" })) el.setAttribute(k, String(v));
    bust.g.appendChild(el);
  };
  path("M -128 -132 Q 0 -168 128 -132 L 126 -100 Q 0 -134 -126 -100 Z", 5);
  path("M 120 -120 L 176 -150 L 168 -112 Z M 120 -112 L 170 -92 L 150 -76 Z", 4.5);
}
export const Bust: React.FC<{ who?: string; look?: MangaLook; act: (t: number) => MangaBustFrame }> = makeBust((rt) => rt.win.Manga.Bust, addBand);

type Mark = string | number;
/** Parallel ink strokes clipped to the path `d`, over the box x0,y0 .. x1,y1: manga hatching for the darkest shadows. */
export const Hatch: React.FC<{ d: string; x0: number; y0: number; x1: number; y1: number; gap?: number; ang?: number; w?: number; op?: number }> = ({ d, x0, y0, x1, y1, gap, ang, w, op }) => {
  const ref = useRef<SVGGElement>(null);
  const rt = useRuntime();
  useToonBuild(() => rt.win.Manga.hatch(ref.current, d, x0, y0, x1, y1, gap, ang, w, op));
  return <g ref={ref} />;
};
/** Sound-effect lettering: heavy, tilted, double outline, centred on x with its baseline at y. Pass `size * ease` to pop it in. */
export const Sfx: React.FC<{ x: number; y: number; text: string; size?: number; rot?: number; fill?: string }> = ({ x, y, text, size = 120, rot = -8, fill = "#ffd97a" }) => (
  <g transform={`rotate(${rot} ${x} ${y})`}>
    <text x={x} y={y} textAnchor="middle" fontFamily="Bangers" fontSize={size} letterSpacing={4} fill="#fff" stroke="#fff" strokeWidth={size * 0.32} strokeLinejoin="round">{text}</text>
    <text x={x} y={y} textAnchor="middle" fontFamily="Bangers" fontSize={size} letterSpacing={4} fill={fill} stroke={MANGA_INK} strokeWidth={size * 0.16} strokeLinejoin="round" paintOrder="stroke">{text}</text>
  </g>
);
const CONFETTI = ["#ffc93c", "#e23b2e", "#fbf3e4", "#4fb3ff"];
/** Confetti falling over the whole frame, drawn with manga ink outlines; `n` pieces, `seed` picks the pattern. */
export const ConfettiRain: React.FC<{ n: number; seed: number }> = ({ n, seed }) => {
  const { t } = useToon();
  const R = rng(seed);
  return (
    <>
      {Array.from({ length: n }, (_, i) => {
        const x0 = R() * 1080;
        const sp = 200 + R() * 220;
        const ph = R() * 1920;
        const spin = R() * 400;
        const y = ((ph + t * sp) % 1980) - 60;
        const x = x0 + Math.sin(t * 2 + i) * 30;
        return <rect key={i} x={-12} y={-7} width={24} height={14} fill={CONFETTI[i % 4]} stroke={MANGA_INK} strokeWidth={2.5} transform={`translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${(spin + t * 300).toFixed(1)})`} />;
      })}
    </>
  );
};
export type { Mark };
