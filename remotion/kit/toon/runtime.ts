// Runs cartoon-shorts' own drawing code (upstream/*.js, copied with a module wrapper) for one film. The upstream code builds SVG/HTML
// with the real DOM and moves everything by seek(t): a pure function of time, so Remotion can ask for any frame in any order.
import animeFactory from "./upstream/anime.js";
import coreFactory from "./upstream/core.js";
import fxFactory from "./upstream/fx.js";
import mangaFactory from "./upstream/manga.js";
import paintedFactory from "./upstream/painted.js";
import toonFactory from "./upstream/toon.js";
import type { ToonTimeline } from "./time";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type ToonRuntime = {
  /** window.Short of cartoon-shorts: T, ups, E, tr, camera, during, shake, ... */
  short: any;
  /** window.FX: set pieces (burst, rays, popIn, skyline, ...) */
  FX: any;
  /** window.Toon: the puppet class plus P (poses), mix, track, cycle, ... */
  Toon: any;
  win: Record<string, any>;
  /** Wires presets, scenes, captions and grain once everything is drawn; resolves when the first frame can be shown. */
  start(fonts?: string[]): Promise<void>;
  seek(t: number): void;
};

/** cartoon-shorts' TIMELINE from the app's beats: line i = beat i. */
export function upstreamTimeline(tl: ToonTimeline) {
  const total = Math.max(0, ...tl.beats.map((b) => b.endS), ...tl.scenes.map((s) => s.endS));
  return {
    total,
    scenes: tl.scenes.map((s) => ({ id: s.id, start: s.startS, end: s.endS })),
    lines: tl.beats.map((b, i) => ({ i, scene: tl.scenes.find((s) => b.startS >= s.startS - 1e-6 && b.startS < s.endS)?.id ?? "", t: b.startS, d: b.endS - b.startS, cap: b.cap })),
  };
}

export function createToonRuntime(tl: ToonTimeline, doc: Document): ToonRuntime {
  const win: Record<string, any> = { TIMELINE: upstreamTimeline(tl) };
  toonFactory(win, doc);
  fxFactory(win, doc);
  animeFactory(win, doc);
  mangaFactory(win, doc);
  paintedFactory(win, doc);
  coreFactory(win, doc);
  return {
    short: win.Short,
    FX: win.FX,
    Toon: win.Toon,
    win,
    start: async (fonts = []) => {
      win.Short.start(undefined, { fonts });
      await win.ready;
    },
    seek: (t) => {
      void win.seek(t);
    },
  };
}
