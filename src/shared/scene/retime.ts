// Render-time re-timing: Build times scenes from text length, before the narration exists. Here the real word times
// decide where each scene starts. Pure: returns a new doc, never touches the input.
import { LIMITS } from "./kinds/common";
import { validateAndCheck } from "./rules";
import type { SceneDoc } from "./schema";

export interface RetimeInput {
  words: ReadonlyArray<{ startS: number; endS: number }>;
  beats: ReadonlyArray<{ id: string; text: string }>;
  narrationDurationS: number;
  /** Video keeps playing this long after the last spoken word. Default 400. */
  tailMs?: number;
  minSceneMs?: number;
}
export type RetimeResult = { ok: true; doc: SceneDoc; mapped: boolean } | { ok: false; errors: string[] };

/** Fields measured in ms from the scene start, scaled with the scene (value = schema cap for that field). */
const MS_FIELDS: Record<string, number | undefined> = { at: LIMITS.maxSceneMs, atMs: LIMITS.maxSceneMs, revealAtMs: LIMITS.maxSceneMs, delayMs: LIMITS.tileDelayMs };

function scaleInner(v: unknown, ratio: number): unknown {
  if (Array.isArray(v)) return v.map((x) => scaleInner(x, ratio));
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => {
        const cap = MS_FIELDS[k];
        if (cap !== undefined && typeof x === "number") return [k, Math.min(cap, Math.round(x * ratio))];
        return [k, scaleInner(x, ratio)];
      }),
    );
  }
  return v;
}

const wordCount = (t: string) => t.split(/\s+/).filter(Boolean).length;

/** Raw start (ms) of each scene from the real word times, or null when the beats and words cannot be matched. */
function wordStarts(doc: SceneDoc, inp: RetimeInput): number[] | null {
  const { words, beats } = inp;
  const counts = beats.map((b) => wordCount(b.text));
  const total = counts.reduce((a, b) => a + b, 0);
  if (words.length === 0 || total === 0 || Math.abs(total - words.length) > 0.15 * words.length) return null;
  const at = (idx: number) => words[Math.min(words.length - 1, Math.round((idx / total) * words.length))]!.startS * 1000;
  const span = new Map<string, [number, number]>();
  let c = 0;
  beats.forEach((b, i) => {
    span.set(b.id, [i === 0 ? 0 : at(c), i === beats.length - 1 ? Number.POSITIVE_INFINITY : at(c + counts[i]!)]);
    c += counts[i]!;
  });
  // Scenes of one beat share the beat's span, split by their old durations.
  const starts: number[] = [];
  for (const [i, s] of doc.scenes.entries()) {
    const sp = span.get(s.beat);
    if (!sp) return null;
    const same = doc.scenes.filter((x) => x.beat === s.beat);
    if (same[0] === s) { starts.push(sp[0]); continue; }
    if (doc.scenes[i - 1]!.beat !== s.beat) return null; // a beat split in two places
    const oldSpan = same.reduce((a, x) => a + x.durationMs, 0);
    const before = same.slice(0, same.indexOf(s)).reduce((a, x) => a + x.durationMs, 0);
    starts.push(Number.isFinite(sp[1]) ? sp[0] + ((sp[1] - sp[0]) * before) / oldSpan : starts[i - 1]! + (before / oldSpan) * 1000);
  }
  return starts;
}

export function retimeScenes(doc: SceneDoc, inp: RetimeInput): RetimeResult {
  const min = inp.minSceneMs ?? 1200;
  const totalMs = Math.round(inp.narrationDurationS * 1000 + (inp.tailMs ?? 400));
  const n = doc.scenes.length;
  if (!(totalMs > 0) || n === 0) return { ok: false, errors: ["no narration length or no scenes to retime"] };
  if (totalMs > LIMITS.maxTotalMs) return { ok: false, errors: [`narration needs ${totalMs} ms, over the ${LIMITS.maxTotalMs} ms limit`] };
  if (n * min > totalMs) return { ok: false, errors: [`${n} scenes cannot each last ${min} ms in ${totalMs} ms`] };

  let raw = wordStarts(doc, inp);
  const mapped = raw !== null;
  if (!raw) {
    const old = doc.scenes.reduce((a, s) => a + s.durationMs, 0);
    let acc = 0;
    raw = doc.scenes.map((s) => { const v = Math.round((acc * totalMs) / old); acc += s.durationMs; return v; });
  }
  // Forward pass: contiguous, from 0, each at least `min`, and the last one still has room for `min`.
  const starts: number[] = [];
  for (let i = 0; i < n; i++) {
    const lo = i === 0 ? 0 : starts[i - 1]! + min;
    const hi = totalMs - (n - i) * min;
    starts.push(i === 0 ? 0 : Math.min(hi, Math.max(lo, Math.round(raw[i]!))));
  }
  const scenes = doc.scenes.map((s, i) => {
    const durationMs = (i === n - 1 ? totalMs : starts[i + 1]!) - starts[i]!;
    return { ...(scaleInner(s, durationMs / s.durationMs) as object), startMs: starts[i]!, durationMs };
  });
  const tooLong = scenes.findIndex((s) => s.durationMs > LIMITS.maxSceneMs);
  if (tooLong >= 0) return { ok: false, errors: [`scene ${tooLong + 1} would last ${scenes[tooLong]!.durationMs} ms, over the ${LIMITS.maxSceneMs} ms limit`] };
  const v = validateAndCheck({ ...doc, scenes });
  return v.ok ? { ok: true, doc: v.doc, mapped } : { ok: false, errors: v.errors };
}
