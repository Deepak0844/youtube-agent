// The shot plan of an AI video (Phase 8.5): one clip per beat, as long as the narration of that beat. Pure: no IO.
// The prompt is the beat's own "visual" sentence (what we see); a beat without one stops the plan, because guessing a picture would spend money on a guess.
import type { CostItem } from "@/server/core/cost-plan";
import { cleanClipPrompt, quoteClip, type VideoModelCap } from "@/server/core/video-clip";

export const MAX_SHOTS = 20;
/** Added to every clip prompt: generated video draws garbled letters, so text is never asked for. */
export const PROMPT_TAIL = "No text, captions, logos or watermarks.";

export interface ShotBeat {
  id: string;
  visual?: string;
}
export interface Shot {
  beatId: string;
  prompt: string;
  seconds: number;
}

/**
 * Whole seconds to ask for: the narration window rounded up, then inside what the model can make (a model with fixed lengths takes the next one up,
 * or its longest). A window longer than the longest clip gets the longest clip; the scene kit loops a clip under a longer beat.
 */
export function clipSeconds(cap: VideoModelCap, windowS: number): number {
  const want = Math.min(cap.maxSeconds, Math.max(cap.minSeconds, Math.ceil(Number.isFinite(windowS) ? windowS : cap.minSeconds)));
  if (!cap.allowedSeconds) return want;
  return cap.allowedSeconds.find((s) => s >= want) ?? Math.max(...cap.allowedSeconds);
}

export type ShotPlan = { ok: true; shots: Shot[] } | { ok: false; problems: string[] };

/** `windows` is seconds of narration per beat id. Every beat must have a visual, a window and a usable prompt. */
export function planShots(beats: readonly ShotBeat[], windows: Readonly<Record<string, number>>, cap: VideoModelCap): ShotPlan {
  const problems: string[] = [];
  if (beats.length === 0) problems.push("The video has no beats to make clips for.");
  if (beats.length > MAX_SHOTS) problems.push(`An AI video can have at most ${MAX_SHOTS} clips; this one has ${beats.length} beats.`);
  const shots: Shot[] = [];
  for (const b of beats.slice(0, MAX_SHOTS)) {
    const visual = (b.visual ?? "").trim();
    const w = Object.hasOwn(windows, b.id) ? windows[b.id] : undefined;
    if (visual === "") problems.push(`Beat ${b.id} has no visual sentence, so there is nothing to ask the video model for.`);
    else if (w === undefined || !Number.isFinite(w) || w <= 0) problems.push(`Beat ${b.id} has no narration time yet.`);
    else {
      const prompt = cleanClipPrompt(`${visual.replace(/[.\s]+$/, "")}. ${PROMPT_TAIL}`);
      if (prompt === null) problems.push(`Beat ${b.id} has a visual that is too long for a clip prompt.`);
      else shots.push({ beatId: b.id, prompt, seconds: clipSeconds(cap, w) });
    }
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, shots };
}

/** The provider part and the model part of a cost item's provider text ("seedance_video/dreamina-seedance-2-0-fast-260128"). */
export function splitClipProvider(text: string): { providerId: string; model: string } | null {
  const m = /^([a-z][a-z0-9_]{2,40})\/([A-Za-z0-9._-]{3,80})$/.exec(text);
  return m ? { providerId: m[1]!, model: m[2]! } : null;
}

/** One `clip` cost item per shot, priced from the owner's per-second price (unpriced refuses). */
export function shotCostItems(shots: readonly Shot[], providerId: string, model: string, price: unknown): CostItem[] {
  return shots.map((s) => ({ kind: "clip", provider: `${providerId}/${model}`, quoteMicroUsd: quoteClip(price, s.seconds) }));
}

const wordsIn = (t: string) => t.split(/\s+/).filter(Boolean).length;

/**
 * Seconds of narration per beat, from the real word times: beats take their share of the spoken words in order (the same matching the
 * renderer uses to retime scenes). Null when the words and the beats cannot be matched (more than 15% apart), so nobody plans clips from a guess.
 */
export function beatWindows(words: ReadonlyArray<{ startS: number; endS: number }>, beats: ReadonlyArray<{ id: string; text: string }>): Record<string, number> | null {
  const counts = beats.map((b) => wordsIn(b.text));
  const total = counts.reduce((a, b) => a + b, 0);
  if (words.length === 0 || total === 0 || Math.abs(total - words.length) > 0.15 * words.length) return null;
  const endS = words[words.length - 1]!.endS;
  const startOf = (idx: number) => words[Math.min(words.length - 1, Math.round((idx / total) * words.length))]!.startS;
  const out: Record<string, number> = {};
  let c = 0;
  beats.forEach((b, i) => {
    const from = i === 0 ? 0 : startOf(c);
    const to = i === beats.length - 1 ? endS : startOf(c + counts[i]!);
    out[b.id] = Math.max(0, to - from);
    c += counts[i]!;
  });
  return out;
}
