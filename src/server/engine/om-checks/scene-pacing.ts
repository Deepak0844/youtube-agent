// Port of OpenMontage lib/verify_scene_pacing.py (AGPL-3.0, https://github.com/calesthio/OpenMontage) at the commit in
// engine-kit/openmontage/UPSTREAM.json: does a TerminalScene's step list line up with the narration cues? Mirrors the frame
// maths inside TerminalScene.tsx. Returns the problems where the Python raises. Proven equal on goldens/pacing-*.json.
import { pyFixed, pyRound } from "./py";

type Step = Record<string, unknown>;
export interface Landmark {
  video_time: number;
  kind: string;
  text: string;
}
const n = (v: unknown, fallback: number) => (typeof v === "number" ? v : fallback);

/** How far one step moves the cursor, in seconds (pills are overlays and do not). Throws on an unknown kind, as the Python does. */
export function stepDuration(step: Step, fps = 30): number {
  const k = step.kind;
  if (k === "cmd") {
    const typeFrames = Math.ceil(String(step.text).length * n(step.typeSpeed, 0.035) * fps);
    return (typeFrames + Math.ceil(n(step.holdSeconds, 0.3) * fps)) / fps;
  }
  if (k === "out") return (Math.max(2, Math.ceil(0.08 * fps)) + Math.ceil(n(step.holdSeconds, 0.15) * fps)) / fps;
  if (k === "pause") return Math.ceil(n(step.seconds, 0) * fps) / fps;
  if (k === "pill") return 0.0;
  throw new Error(`Unknown step kind: '${String(k)}'`);
}

/** trace(): the video time of every visible step. */
export function traceTerminalSteps(steps: Step[], sceneStart = 0.0, fps = 30): Landmark[] {
  let cursor = 0.0;
  const out: Landmark[] = [];
  for (const s of steps) {
    const k = String(s.kind);
    if (k === "cmd" || k === "out" || k === "pill") out.push({ video_time: pyRound(cursor + sceneStart, 2), kind: k.toUpperCase(), text: typeof s.text === "string" ? s.text : "" });
    cursor += stepDuration(s, fps);
  }
  return out;
}

/** assert_alignment(): every cue needs a visible step within the tolerance, and the steps must fit the scene. */
export function checkAlignment(steps: Step[], sceneStart: number, sceneEnd: number, cues: Array<[number, string]>, tolerance = 1.0, fps = 30): string[] {
  const landmarks = traceTerminalSteps(steps, sceneStart, fps);
  const errors: string[] = [];
  for (const [cueTime, cueDesc] of cues) {
    if (landmarks.length === 0) {
      errors.push(`cue ${pyFixed(cueTime, 2)}s (${cueDesc}): no landmarks at all`);
      continue;
    }
    const closest = landmarks.reduce((best, lm) => (Math.abs(lm.video_time - cueTime) < Math.abs(best.video_time - cueTime) ? lm : best));
    const delta = closest.video_time - cueTime;
    if (Math.abs(delta) > tolerance) {
      errors.push(
        `cue ${pyFixed(cueTime, 2)}s (${cueDesc}) has no visual within ±${pyFixed(tolerance, 1)}s — ` +
          `closest is ${closest.kind} at ${pyFixed(closest.video_time, 2)}s (${delta >= 0 ? "+" : ""}${pyFixed(delta, 2)}s off): ${closest.text.slice(0, 40)}`,
      );
    }
  }
  const cursor = steps.reduce((t, s) => t + stepDuration(s, fps), 0);
  const endVt = sceneStart + cursor;
  const sceneDuration = sceneEnd - sceneStart;
  if (cursor > sceneDuration + 0.5) {
    errors.push(`steps overflow scene: cursor ends at ${pyFixed(endVt, 2)}s but scene_end is ${pyFixed(sceneEnd, 2)}s (overflow ${pyFixed(cursor - sceneDuration, 2)}s)`);
  }
  if (cursor < sceneDuration - 5.0) {
    errors.push(`steps underfill scene by ${pyFixed(sceneDuration - cursor, 2)}s — last visible step holds frozen from ${pyFixed(endVt, 2)}s to ${pyFixed(sceneEnd, 2)}s. Add a closer pause.`);
  }
  return errors;
}
