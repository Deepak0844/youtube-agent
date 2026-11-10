import { chapterSceneRange, planClip } from "./derive-short";

// What the "Shorts from this video" panel shows (Phase 6b.4): the chapters of a long video as clips, with the length each would have and
// whether it is a usable length. Pure: no IO. The scenes are the long video's, re-timed to the narration the same way the derive step does it.

interface TimedScene {
  beat: string;
  startMs: number;
  durationMs: number;
}
export interface ChapterClip {
  /** 1-based chapter number, as in the outline */
  n: number;
  title: string;
  /** 1-based scene numbers, inclusive */
  firstScene: number;
  lastScene: number;
  lengthMs: number;
  /** a plain sentence when this chapter cannot be a short as it is (too short, too long), else null */
  problem: string | null;
}

/** Each outline chapter whose scenes form one run, as a clip. A chapter with no scenes (or scenes that are not one run) is left out. */
export function chapterClips(scenes: readonly TimedScene[], chapterTitles: readonly string[]): ChapterClip[] {
  const out: ChapterClip[] = [];
  chapterTitles.forEach((title, i) => {
    const range = chapterSceneRange(scenes, i + 1);
    if (!range) return;
    const plan = planClip(scenes, range);
    const first = scenes[range.from]!;
    const last = scenes[range.to]!;
    out.push({ n: i + 1, title, firstScene: range.from + 1, lastScene: range.to + 1, lengthMs: last.startMs + last.durationMs - first.startMs, problem: plan.ok ? null : plan.reason });
  });
  return out;
}

/** [start, end] in ms of every scene, for the live length in the form. */
export const sceneBounds = (scenes: readonly TimedScene[]): Array<[number, number]> => scenes.map((s) => [s.startMs, s.startMs + s.durationMs]);

/** The length in ms of scenes first..last (1-based, inclusive), or null when the numbers are not a run inside the video. */
export function boundsLengthMs(bounds: ReadonlyArray<readonly [number, number]>, first: number, last: number): number | null {
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first || last > bounds.length) return null;
  return bounds[last - 1]![1] - bounds[first - 1]![0];
}
