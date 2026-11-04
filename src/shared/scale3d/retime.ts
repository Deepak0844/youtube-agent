// Timing of a 3D scale description against the real narration. Pure: returns a new scene, never touches the input.
// Build writes beat lengths from the text (the narration does not exist yet); Render calls retimeScale3d with the real word
// times so the ruler, the labels and the camera land on the spoken words. Each beat's `caption` is its share of the narration.
import { SCALE3D_LIMITS as L, type Scale3dScene } from "./schema";

const WORDS_PER_S = 2.7; // same estimate the draft uses (2.7 words a second)
const TAIL_S = 0.4; // the video keeps playing a moment after the last spoken word
const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
const clampBeat = (s: number) => Math.round(Math.min(L.maxBeatS, Math.max(L.minBeatS, s)) * 1000) / 1000;

/** Beat lengths (seconds) from caption length alone: the whole video is the narration estimate, held inside the 30 to 45 s the schema asks for. */
export function estimateBeatDurations(captions: readonly string[], narrationWords: number): number[] {
  const counts = captions.map((c) => Math.max(1, words(c)));
  const sum = counts.reduce((a, b) => a + b, 0);
  const total = Math.min(L.maxTotalS, Math.max(L.minTotalS, narrationWords / WORDS_PER_S + TAIL_S));
  return counts.map((c) => clampBeat((c / sum) * total));
}

export type RetimeScale3dResult = { ok: true; scene: Scale3dScene; totalS: number } | { ok: false; reason: string };

/** Beat starts from the real word times: beat i begins at the word where its share of the spoken words begins. */
export function retimeScale3d(scene: Scale3dScene, input: { words: ReadonlyArray<{ startS: number; endS: number }>; narrationDurationS: number }): RetimeScale3dResult {
  const w = [...input.words].sort((a, b) => a.startS - b.startS);
  if (w.length === 0) return { ok: false, reason: "no word times" };
  const counts = scene.beats.map((b) => Math.max(1, words(b.caption)));
  const sum = counts.reduce((a, b) => a + b, 0);
  const endS = Math.max(input.narrationDurationS, w[w.length - 1]!.endS + 0.3) + TAIL_S;
  const starts: number[] = [];
  let acc = 0;
  for (const c of counts) {
    starts.push(starts.length === 0 ? 0 : w[Math.min(w.length - 1, Math.round((acc / sum) * w.length))]!.startS);
    acc += c;
  }
  const durations = starts.map((s, i) => clampBeat((i + 1 < starts.length ? starts[i + 1]! : endS) - s));
  const beats = scene.beats.map((b, i) => ({ ...b, duration_s: durations[i]! }));
  return { ok: true, scene: { ...scene, beats }, totalS: Math.round(durations.reduce((a, b) => a + b, 0) * 1000) / 1000 };
}
