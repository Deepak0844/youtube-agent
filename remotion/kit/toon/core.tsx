import React, { useContext, useLayoutEffect, useRef } from "react";
import { SceneContext, sceneParts, useSceneId } from "./scene-parts";
import { clamp, eio, eout, lerp, ToonFilm, useRuntime, useToon, useToonBuild, type ToonClock, type ToonPalette } from "./Stage";
import { ToonContext, type ToonCharacter, type ToonInput } from "./context";

// yt-toon/core: the film, scenes, text overlays, entrance presets, camera and whole-frame effects of cartoon-shorts.
// Times are beat marks (B5, B5e, B5%60, B5+.3), scene ids (hook, hooke, hook+1) or seconds; see time.ts.
export { ToonFilm, useToon, eout, eio, clamp, lerp };
export type { ToonClock, ToonPalette, ToonCharacter, ToonInput };

/** The SVG transform string cartoon-shorts uses for a moved piece: translate(x,y) rotate(r) scale(s). */
export const trf = (x: number, y: number, s = 1, r = 0): string => `translate(${(+x).toFixed(1)},${(+y).toFixed(1)}) rotate(${(+r).toFixed(2)}) scale(${(+s).toFixed(4)})`;

export const ENTRANCE_PRESETS = ["slam", "smash", "up", "down", "left", "right", "fade", "out", "pop", "stamp", "growx", "growy", "nudge", "wipe"] as const;
export type EntrancePreset = (typeof ENTRANCE_PRESETS)[number];
export type Transition = "flash" | "zoom" | "whip" | "glitch" | "cut";

/**
 * One scene of the film: shown only between its start and its end (the scene id must be in the timeline), entered with `tr`.
 * `children` are drawn in the scene's SVG layer (1080 x 1920 portrait, 1920 x 1080 landscape) and move with <Camera>; `above` is SVG drawn over
 * that layer which the camera does not move (sound words, bursts); `overlays` are HTML text boxes (<Ov>) above both.
 */
export const Scene: React.FC<{ id: string; tr?: Transition; children?: React.ReactNode; above?: React.ReactNode; overlays?: React.ReactNode }> = ({ id, tr = "zoom", children, above, overlays }) => {
  const input = useContext(ToonContext);
  const [W, H] = input?.orientation === "landscape" ? [1920, 1080] : [1080, 1920];
  return (
    <SceneContext.Provider value={id}>
      <div className="scene" data-scene={id} data-tr={tr}>
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H}>
          <defs />
          <g className="cam">{children}</g>
          {above}
        </svg>
        {overlays}
      </div>
    </SceneContext.Provider>
  );
};

/** `slam@B3+.2` style entrance list: one preset at a time or several ("slam" in, "out" later). */
export type EntranceStep = { preset: EntrancePreset; at: string | number; dur?: number };
const kString = (steps: EntranceStep[]) => steps.map((s) => `${s.preset}@${s.at}${s.dur !== undefined ? `:${s.dur}` : ""}`).join(" ");

/** An HTML text box over the scene (titles, kickers, labels, cards). `css` is the box's position and look, e.g. "left:0;right:0;top:300px;text-align:center". */
export const Ov: React.FC<{ css?: string; cls?: string; enter?: EntranceStep[]; on?: string; fit?: boolean; children?: React.ReactNode }> = ({ css, cls, enter, on, fit, children }) => {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current) ref.current.style.cssText = css ?? "";
  }, [css]);
  return (
    <div ref={ref} className={"a" + (cls ? " " + cls : "")} data-k={enter && enter.length ? kString(enter) : undefined} data-on={on} data-fit={fit ? "" : undefined}>
      {children}
    </div>
  );
};

/** Wraps SVG drawing in an entrance preset (slam, pop, up, fade...) at a mark. */
export const Anim: React.FC<{ preset: EntrancePreset; at: string | number; dur?: number; also?: EntranceStep[]; children?: React.ReactNode }> = ({ preset, at, dur, also = [], children }) => (
  <g data-k={kString([{ preset, at, dur }, ...also])}>{children}</g>
);

/** Shows its SVG children only between two marks. */
export const Show: React.FC<{ from: string | number; to: string | number; children?: React.ReactNode }> = ({ from, to, children }) => {
  const { t, T } = useToon();
  return <g style={t >= T(from) && t < T(to) ? undefined : { display: "none" }}>{children}</g>;
};

/** Slow camera push over the scene (or a window of it): scale `from` -> `to` around (cx, cy). Do not combine it with a style's own camera. */
export const Camera: React.FC<{ a?: string | number; b?: string | number; from?: number; to?: number; cx?: number; cy?: number }> = ({ a, b, from = 1, to = 1.06, cx = 540, cy = 900 }) => {
  const id = useSceneId();
  const rt = useRuntime();
  useToonBuild(() => rt.short.camera(sceneParts(id), a ?? id, b ?? id + "e", from, to, cx, cy));
  return null;
};

/** The whole frame shakes at a mark. */
export const Shake: React.FC<{ at: string | number; dur?: number; amp?: number }> = ({ at, dur, amp }) => {
  const rt = useRuntime();
  useToonBuild(() => rt.short.shake(at, dur, amp));
  return null;
};
/** A hit frame: inverted for a few frames, then a colour split. Put <FlashAt> 0.1 s later, not at the same time. */
export const Impact: React.FC<{ at: string | number; frames?: number }> = ({ at, frames }) => {
  const rt = useRuntime();
  useToonBuild(() => rt.short.impact(at, frames));
  return null;
};
export const Chroma: React.FC<{ at: string | number; dur?: number; px?: number }> = ({ at, dur, px }) => {
  const rt = useRuntime();
  useToonBuild(() => rt.short.chroma(at, dur, px));
  return null;
};
export const FlashAt: React.FC<{ at: string | number; opacity?: number; dur?: number }> = ({ at, opacity, dur }) => {
  const rt = useRuntime();
  useToonBuild(() => rt.short.flashAt(at, opacity, dur));
  return null;
};

// Gradients and patterns: plain SVG with an id you choose, used as fill="url(#id)". Ids are shared by the whole film, so pick unique ones.
export type GradStop = [offset: number, color: string, opacity?: number];
const Stops: React.FC<{ stops: GradStop[] }> = ({ stops }) => (
  <>
    {stops.map(([o, c, op = 1], i) => (
      <stop key={i} offset={o} stopColor={c} stopOpacity={op} />
    ))}
  </>
);
export const LinGrad: React.FC<{ id: string; stops: GradStop[]; x1?: number; y1?: number; x2?: number; y2?: number }> = ({ id, stops, x1 = 0, y1 = 0, x2 = 0, y2 = 1 }) => (
  <linearGradient id={id} x1={x1} y1={y1} x2={x2} y2={y2}>
    <Stops stops={stops} />
  </linearGradient>
);
export const RadGrad: React.FC<{ id: string; stops: GradStop[]; cx?: number; cy?: number; r?: number }> = ({ id, stops, cx = 0.5, cy = 0.5, r = 0.5 }) => (
  <radialGradient id={id} cx={cx} cy={cy} r={r}>
    <Stops stops={stops} />
  </radialGradient>
);
export const DotsPattern: React.FC<{ id: string; color?: string; size?: number; r?: number; op?: number }> = ({ id, color = "#000", size = 18, r = 4, op = 1 }) => (
  <pattern id={id} width={size} height={size} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
    <circle cx={size / 2} cy={size / 2} r={r} fill={color} fillOpacity={op} />
  </pattern>
);
