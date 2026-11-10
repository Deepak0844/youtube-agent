// A short cut out of a long video (Phase 6b.4): a run of consecutive scenes of the LONG video, re-rendered in the portrait composition (the
// scenes are already laid out for portrait), with the narration cut out of the long video's narration and its caption words shifted to start at 0.
// Pure: no IO. Works on a long doc that is already re-timed to the real narration (Render re-times at render time and does not store the result),
// so every time here is a real time on the long video's timeline.

/** A clip is at least this long and at most this long (a short's own limits are wider: 180 s). */
export const CLIP_MIN_MS = 15_000;
export const CLIP_MAX_MS = 90_000;

interface TimedScene {
  beat: string;
  startMs: number;
  durationMs: number;
}
export interface Word {
  word: string;
  startS: number;
  endS: number;
  estimated?: boolean;
}
export interface ClipRange {
  /** index of the first scene, zero-based */
  from: number;
  /** index of the last scene, zero-based, inclusive */
  to: number;
}
export interface ClipWindow extends ClipRange {
  startMs: number;
  endMs: number;
  durationMs: number;
}

/** The window of scenes from..to on the long video's timeline, or a plain sentence saying why it cannot be a short. */
export function planClip(scenes: readonly TimedScene[], r: ClipRange, o: { minMs?: number; maxMs?: number } = {}): { ok: true; window: ClipWindow } | { ok: false; reason: string } {
  const minMs = o.minMs ?? CLIP_MIN_MS;
  const maxMs = o.maxMs ?? CLIP_MAX_MS;
  const whole = Number.isInteger(r.from) && Number.isInteger(r.to);
  if (!whole || r.from < 0 || r.to >= scenes.length || r.from > r.to) return { ok: false, reason: "Pick a first and a last scene that exist, the first not after the last." };
  const first = scenes[r.from]!;
  const last = scenes[r.to]!;
  const startMs = first.startMs;
  const endMs = last.startMs + last.durationMs;
  const durationMs = endMs - startMs;
  if (!(durationMs > 0)) return { ok: false, reason: "Those scenes have no length." };
  if (durationMs < minMs) return { ok: false, reason: `A short must be at least ${Math.round(minMs / 1000)} seconds; this is ${Math.round(durationMs / 1000)}. Add more scenes.` };
  if (durationMs > maxMs) return { ok: false, reason: `A short from here is at most ${Math.round(maxMs / 1000)} seconds; this is ${Math.round(durationMs / 1000)}. Pick fewer scenes.` };
  return { ok: true, window: { ...r, startMs, endMs, durationMs } };
}

/** The scenes of one chapter: every scene whose beat id starts with c<n>_ (the long script's beat ids), as a zero-based range, or null when it has none or they are not one run. */
export function chapterSceneRange(scenes: readonly TimedScene[], chapter: number): ClipRange | null {
  const idx = scenes.flatMap((s, i) => (s.beat.startsWith(`c${chapter}_`) ? [i] : []));
  if (idx.length === 0 || idx[idx.length - 1]! - idx[0]! + 1 !== idx.length) return null;
  return { from: idx[0]!, to: idx[idx.length - 1]! };
}

/** The scenes of the window with their starts shifted so the clip begins at 0. Everything else in a scene (its own inner times are relative to the scene) is untouched. */
export function clipScenes<T extends TimedScene>(scenes: readonly T[], w: ClipWindow): T[] {
  return scenes.slice(w.from, w.to + 1).map((s) => ({ ...s, startMs: s.startMs - w.startMs }));
}

/** The caption words spoken inside the window, shifted to start at 0. A word that straddles an edge is cut to the window. Estimated flags are kept. */
export function clipWords(words: readonly Word[], w: Pick<ClipWindow, "startMs" | "endMs">): Word[] {
  const a = w.startMs / 1000;
  const b = w.endMs / 1000;
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  return words
    .filter((x) => x.endS > a && x.startS < b)
    .map((x) => ({ ...x, startS: r3(Math.max(x.startS, a) - a), endS: r3(Math.min(x.endS, b) - a) }));
}

/** The script beats the clipped scenes use, once each, in the script's own order. */
export function clipBeats<B extends { id?: unknown }>(beats: readonly B[], scenes: readonly Pick<TimedScene, "beat">[]): B[] {
  const used = new Set(scenes.map((s) => s.beat));
  return beats.filter((b) => typeof b.id === "string" && used.has(b.id));
}

/** The narration of the clip: the text of its beats, in order. (Beat text read in order is the narration, by the script contract.) */
export const clipNarration = (beats: readonly { text?: unknown }[]): string => beats.map((b) => (typeof b.text === "string" ? b.text.trim() : "")).filter(Boolean).join(" ");

/** ffmpeg arguments that cut [startMs, endMs) out of a narration file into a wav (re-encoded, so the cut is sample-exact). Only the file protocol. */
export function cutAudioArgs(inFile: string, outFile: string, w: Pick<ClipWindow, "startMs" | "durationMs">): string[] {
  return ["-nostdin", "-hide_banner", "-y", "-protocol_whitelist", "file", "-i", inFile, "-ss", (w.startMs / 1000).toFixed(3), "-t", (w.durationMs / 1000).toFixed(3), "-vn", "-c:a", "pcm_s16le", outFile];
}
