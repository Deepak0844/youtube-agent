// Timing of a 3D scene against the real narration. Pure: returns a new scene, never touches the input.
// The director writes shot lengths from the story alone (the narration does not exist yet); Render calls retimeScene3d with the real word
// times so each story beat's shots start where its line starts being spoken. Shots are named after their beat ("hook", "hook_2").
import { SCENE3D_LIMITS as L, type Scene3d } from "./schema";
import { shotsTotalS, validateScene3d } from "./validate";

export const RETIME_SHOT_MIN_S = 2;
export const RETIME_SHOT_MAX_S = 12;
const TAIL_LOOP_S = 0.4; // the last line leads straight back into the hook frame: end soon after the last word
const TAIL_HOLD_S = 1.2; // without the loop-back the picture holds a moment longer
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const clampShot = (s: number) => r3(Math.min(RETIME_SHOT_MAX_S, Math.max(RETIME_SHOT_MIN_S, s)));

/** The story beat a shot belongs to: its id is the beat id, or the beat id plus _2, _3 ... (the longest matching beat id wins). */
export function shotBeatId(shotId: string, beatIds: readonly string[]): string | null {
  let best: string | null = null;
  for (const b of beatIds) if ((shotId === b || shotId.startsWith(`${b}_`)) && (best === null || b.length > best.length)) best = b;
  return best;
}

export type RetimeBeat = { id: string; words: number };
export type RetimeScene3dResult = { ok: true; scene: Scene3d; totalS: number } | { ok: false; reason: string };

export function retimeScene3d(
  scene: Scene3d,
  input: { beats: readonly RetimeBeat[]; words: ReadonlyArray<{ startS: number; endS: number }>; narrationDurationS: number; loopBack?: boolean },
): RetimeScene3dResult {
  const w = [...input.words].sort((a, b) => a.startS - b.startS);
  if (w.length === 0) return { ok: false, reason: "no word times" };
  if (input.beats.length === 0) return { ok: false, reason: "no story beats" };
  const ids = input.beats.map((b) => b.id);
  const counts = input.beats.map((b) => Math.max(1, b.words));
  const sum = counts.reduce((a, b) => a + b, 0);
  const starts: number[] = [];
  let acc = 0;
  for (const c of counts) {
    starts.push(starts.length === 0 ? 0 : w[Math.min(w.length - 1, Math.round((acc / sum) * w.length))]!.startS);
    acc += c;
  }
  const endS = Math.max(input.narrationDurationS, w[w.length - 1]!.endS + 0.3) + (input.loopBack === false ? TAIL_HOLD_S : TAIL_LOOP_S);

  // Consecutive shots of the same beat form a group; a shot that names no beat joins the group before it.
  const groups: { beat: number; shots: number[] }[] = [];
  scene.shots.forEach((s, i) => {
    const id = shotBeatId(s.id, ids);
    const beat = id === null ? (groups.at(-1)?.beat ?? 0) : ids.indexOf(id);
    const last = groups.at(-1);
    if (last && beat <= last.beat) last.shots.push(i);
    else groups.push({ beat, shots: [i] });
  });
  const durations = scene.shots.map((s) => s.duration_s);
  groups.forEach((g, gi) => {
    const from = starts[g.beat]!;
    const to = gi + 1 < groups.length ? starts[groups[gi + 1]!.beat]! : endS;
    const orig = g.shots.reduce((a, i) => a + scene.shots[i]!.duration_s, 0);
    for (const i of g.shots) durations[i] = clampShot(((to - from) * scene.shots[i]!.duration_s) / orig);
  });
  const totalS = shotsTotalS(durations.map((duration_s) => ({ duration_s })));
  if (totalS > L.maxTotalS) return { ok: false, reason: `the narration needs ${totalS} s but a 3D scene can run at most ${L.maxTotalS} s` };

  // Animations follow their shots: old time -> new time, piecewise linear over the shot boundaries.
  const oldB = [0];
  const newB = [0];
  scene.shots.forEach((s, i) => {
    oldB.push(oldB[i]! + s.duration_s);
    newB.push(newB[i]! + durations[i]!);
  });
  const n = scene.shots.length;
  const mapT = (t: number): number => {
    for (let k = 0; k < n; k++) if (t <= oldB[k + 1]!) return newB[k]! + ((t - oldB[k]!) / (oldB[k + 1]! - oldB[k]!)) * (newB[k + 1]! - newB[k]!);
    return newB[n]! + (t - oldB[n]!);
  };
  const elements = scene.elements.map((e) => ({
    ...e,
    animations: e.animations.map((a) => {
      const start = Math.min(r3(mapT(a.start_s)), r3(totalS - 0.1));
      const dur = Math.max(0.1, Math.min(r3(mapT(a.start_s + a.duration_s)) - start, r3(totalS - start)));
      return { ...a, start_s: Math.max(0, start), duration_s: dur };
    }),
  }));
  const out = validateScene3d({ ...scene, elements, shots: scene.shots.map((s, i) => ({ ...s, duration_s: durations[i]! })) });
  if (!out.ok) return { ok: false, reason: out.errors[0] ?? "the re-timed scene is not valid" };
  return { ok: true, scene: out.scene, totalS: out.totalS };
}
