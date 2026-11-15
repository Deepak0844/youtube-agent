// Clip Factory CF3b: plan a batch of clips from a source's word times, review it with the CF3a checks, and apply the owner's one
// approval with a per-clip drop. Pure: no IO, no database. The gate row, the stage that cuts and renders, and the batch screen
// are wired on top of this (CF4). Nothing here publishes; an approved clip becomes a normal Short that has its own publish gates.
import { checkClip, type ClipCheck } from "@/server/core/clip-checks";
import { findMoments, type MomentOpts } from "@/server/core/clip-moments";
import { clipWords, type Word } from "@/server/core/derive-short";

export interface BatchClip {
  /** c1, c2... in time order; stable for one planned batch */
  id: string;
  startS: number;
  endS: number;
  durationS: number;
  hook: string;
  score: number;
  reason: string;
  /** the caption words of the clip, shifted to start at 0 */
  words: Word[];
}
export interface Measured {
  lufs: number | null;
  truePeakDb: number | null;
}
export interface ReviewedClip {
  id: string;
  hook: string;
  durationS: number;
  checks: ClipCheck[];
  ok: boolean;
  warnings: string[];
}
export interface BatchReview {
  clips: ReviewedClip[];
  /** how many clips have at least one warning */
  needAttention: number;
}

/** The clips of a source: up to opts.max moments, each with its caption words shifted to 0. */
export function planBatch(source: readonly Word[], opts: MomentOpts = {}): { ok: true; clips: BatchClip[] } | { ok: false; reason: string } {
  const found = findMoments(source, opts);
  if (!found.ok) return found;
  return {
    ok: true,
    clips: found.moments.map((m, i) => ({
      id: `c${i + 1}`,
      startS: m.startS,
      endS: m.endS,
      durationS: Math.round((m.endS - m.startS) * 1000) / 1000,
      hook: m.hook,
      score: m.score,
      reason: m.reason,
      words: clipWords(source, { startMs: m.startS * 1000, endMs: m.endS * 1000 }),
    })),
  };
}

/** Runs the CF3a checks on every clip. A clip with no measurement is reviewed as unmeasured (a warning), never skipped or passed. */
export function reviewBatch(clips: readonly BatchClip[], measured: Readonly<Record<string, Measured>>): BatchReview {
  const reviewed = clips.map((c): ReviewedClip => {
    const m = measured[c.id] ?? { lufs: null, truePeakDb: null };
    const r = checkClip({ words: c.words, durationS: c.durationS, lufs: m.lufs, truePeakDb: m.truePeakDb });
    return { id: c.id, hook: c.hook, durationS: c.durationS, checks: r.checks, ok: r.ok, warnings: r.warnings };
  });
  return { clips: reviewed, needAttention: reviewed.filter((c) => !c.ok).length };
}

/**
 * The owner's one approval: every clip is approved except the ones they dropped. A clip with warnings can still be approved (the
 * owner decides). Refuses a drop of a clip that is not in the batch (a stale or forged screen) and an approval that keeps nothing.
 */
export function approveBatch(review: BatchReview, droppedIds: readonly string[]): { ok: true; approved: string[]; dropped: string[] } | { ok: false; reason: string } {
  const known = new Set(review.clips.map((c) => c.id));
  const unknown = droppedIds.filter((id) => !known.has(id));
  if (unknown.length > 0) return { ok: false, reason: "The batch changed: a clip you dropped is no longer in it. Reload the screen." };
  const dropped = new Set(droppedIds);
  const approved = review.clips.filter((c) => !dropped.has(c.id)).map((c) => c.id);
  if (approved.length === 0) return { ok: false, reason: "Every clip was dropped. Keep at least one clip, or discard the batch." };
  return { ok: true, approved, dropped: [...dropped].sort() };
}
