import React, { createContext, useContext, useLayoutEffect, useMemo, useRef } from "react";
import { AbsoluteFill, continueRender, delayRender, useCurrentFrame, useVideoConfig } from "remotion";
import { ToonContext } from "./context";
import { CORE_CSS } from "./css";
import { paperTileUrl } from "./paper-defs";
import { createToonRuntime, type ToonRuntime } from "./runtime";
import { CARTOON_LOOKS, cartoonStyleModule } from "./styles";
import { resolveMark, type ToonTimeline } from "./time";

// The film: one cartoon-shorts page (#v with #world, #flash, #vig, #grain, #cap) drawn in the real DOM. Children (scenes, puppets, set
// pieces) draw once on mount through cartoon-shorts' own code; every frame the film only calls seek(t). Remotion renders in Chrome, so
// CSS filters, clip paths and the Web Animations API behave exactly as in cartoon-shorts' own page.

export const RuntimeContext = createContext<ToonRuntime | null>(null);
export const useRuntime = (): ToonRuntime => {
  const rt = useContext(RuntimeContext);
  if (!rt) throw new Error("yt-toon components must be drawn inside <ToonFilm>");
  return rt;
};

const FONTS = ["400 100px Anton", "400 100px Bangers", "800 30px Inter", "900 100px Fraunces", "italic 900 100px Fraunces", "900 60px Nunito", "800 30px Nunito"];
const NOTO = "'Noto Sans Devanagari','Noto Sans Tamil','Noto Sans Telugu','Noto Sans Kannada','Noto Sans Malayalam'";

export type ToonPalette = Partial<Record<"ink" | "paper" | "gold" | "wine" | "black" | "blue" | "red" | "sky" | "green", string>>;

/** The time helpers a scene may read while it draws (seconds from the start of the video). */
export type ToonClock = { t: number; T: (mark: string | number) => number; prog: (t: number, a: string | number, b: string | number) => number };
export const eout = (x: number) => 1 - Math.pow(1 - x, 3);
export const eio = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
export const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));
export const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

const TimelineContext = createContext<ToonTimeline | null>(null);
export function useToon(): ToonClock {
  const tl = useContext(TimelineContext);
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (!tl) throw new Error("yt-toon components must be drawn inside <ToonFilm>");
  return useMemo(() => {
    const T = (m: string | number) => resolveMark(m, tl);
    return { t: frame / fps, T, prog: (t, a, b) => clamp((t - T(a)) / (T(b) - T(a))) };
  }, [tl, frame, fps]);
}

/** Runs `fn` once, after this component's DOM exists and before the film wires its animations (children first). */
export function useToonBuild(fn: (rt: ToonRuntime) => void): void {
  const rt = useRuntime();
  const done = useRef(false);
  useLayoutEffect(() => {
    if (done.current) return;
    done.current = true;
    fn(rt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export const ToonFilm: React.FC<{ palette?: ToonPalette; bg?: string; children?: React.ReactNode }> = ({ palette, bg, children }) => {
  const input = useContext(ToonContext);
  if (!input) throw new Error("a cartoon scene needs the cartoon timeline from the host (ToonContext)");
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const rt = useMemo(() => createToonRuntime(input.timeline, typeof document === "undefined" ? ({} as Document) : document), [input.timeline]);
  const state = useRef({ ready: false, t: 0 });
  useLayoutEffect(() => {
    const h = delayRender("cartoon film");
    let live = true;
    void rt
      .start(FONTS)
      .then(() => {
        if (!live) return;
        state.current.ready = true;
        rt.seek(state.current.t);
      })
      .finally(() => continueRender(h));
    return () => {
      live = false;
    };
  }, [rt]);
  useLayoutEffect(() => {
    state.current.t = frame / fps;
    if (state.current.ready) rt.seek(frame / fps);
  });
  const tileUrl = useMemo(() => ((input.style === "cartoon_paper" || input.style === "cartoon_painted") && typeof document !== "undefined" ? paperTileUrl() : ""), [input.style]);
  const [W, H] = input.orientation === "landscape" ? [1920, 1080] : [1080, 1920];
  const vars: Record<string, string> = { "--title": `'Anton',Impact,${NOTO},sans-serif`, "--comic": `'Bangers','Anton',${NOTO},sans-serif`, "--body": `'Inter',${NOTO},system-ui,sans-serif` };
  const look = CARTOON_LOOKS[cartoonStyleModule(input.style ?? "cartoon_comic")];
  for (const [k, v] of Object.entries({ ...look.palette, ...(palette ?? {}) })) vars[`--${k}`] = v;
  const landscape = input.orientation === "landscape" ? `#v{width:${W}px;height:${H}px}.scene>svg{width:${W}px;height:${H}px}#cap{left:160px;right:160px;top:${H - 300}px;height:200px;font-size:78px}` : "";
  return (
    <TimelineContext.Provider value={input.timeline}>
      <RuntimeContext.Provider value={rt}>
        <AbsoluteFill>
          <style>{CORE_CSS + look.css + landscape}</style>
          <div id="v" style={{ ...(vars as React.CSSProperties), background: bg ?? look.bg }} data-w={W} data-h={H}>
            <div id="world">{children}</div>
            <div id="flash" />
            {input.style === "cartoon_paper" || input.style === "cartoon_painted" ? <div id="paper" style={typeof document === "undefined" ? undefined : { backgroundImage: `url(${tileUrl})` }} /> : null}
            <div id="vig" />
            <div id="grain" />
            <div id="cap" />
          </div>
        </AbsoluteFill>
      </RuntimeContext.Provider>
    </TimelineContext.Provider>
  );
};
