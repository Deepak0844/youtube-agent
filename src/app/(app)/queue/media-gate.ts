// Never refresh the page under a playing <video>/<audio>: the re-render would restart it. Structural types so tests need no DOM.
export const PLAYBACK_RECHECK_MS = 2_000;

type MediaLike = { paused: boolean; ended: boolean };
export type MediaDoc = { querySelectorAll: (sel: string) => ArrayLike<MediaLike> };

export function isMediaPlaying(doc: MediaDoc): boolean {
  return Array.from(doc.querySelectorAll("video,audio")).some((m) => !m.paused && !m.ended);
}

/** Runs `refresh` now unless media is playing; then asks `later(ms)` to try again. */
export function refreshUnlessPlaying(doc: MediaDoc, refresh: () => void, later: (ms: number) => void): void {
  if (isMediaPlaying(doc)) later(PLAYBACK_RECHECK_MS);
  else refresh();
}
