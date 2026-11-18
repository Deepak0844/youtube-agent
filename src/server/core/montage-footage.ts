import { MIN_SCORE, namesPerson, PERSON_TAGS, words } from "./picture-rank";
import { CLIP_MAX_BYTES, CLIP_MIN_HEIGHT, type ClipCandidate } from "./clip-rank";

// Montage M1 (pure, no IO): for each slot of a thematic brief (what the footage should show and for how many seconds), pick the best free stock clip.
// A clip is used once. A slot with no clip that matches well enough stays unfilled and is reported (never filled with a bad match). Every pick keeps its
// licence and credit line, shown at the gate. Unlike pictures (clip-rank.ts, 5 to 20 s clips for a beat), a montage clip only has to be long enough for its slot.

export interface FootageSlot {
  id: string;
  /** words to search and match on, e.g. ["ocean", "waves"] */
  query: readonly string[];
  /** how many seconds of footage this slot needs on screen */
  seconds: number;
}

export interface FootagePick {
  slotId: string;
  cand: ClipCandidate;
  score: number;
  /** the line shown at the gate */
  licenceLine: string;
}

export interface FootagePlan {
  picks: FootagePick[];
  /** slots no acceptable clip was found for */
  unfilled: string[];
}

/** Match score 0..1: title words count double, tag words once. Null when the clip cannot serve the slot (too short, too small or too big a file, no licence). */
export function scoreFootage(slot: FootageSlot, c: ClipCandidate): number | null {
  if (!(slot.seconds > 0) || !(c.durationS >= slot.seconds)) return null;
  if (!(c.bytes > 0 && c.bytes <= CLIP_MAX_BYTES) || !(c.height >= CLIP_MIN_HEIGHT) || !(c.width > 0)) return null;
  if (c.licence.trim() === "") return null;
  if (PERSON_TAGS.test(c.text) && !namesPerson({ search: slot.query, visual: "" })) return null; // a stranger's face only where the shot is about people
  const want = words(slot.query.join(" "));
  if (want.length === 0) return null;
  const title = new Set(words(c.title));
  const text = new Set(words(c.text));
  let sum = 0;
  for (const w of want) sum += title.has(w) ? 2 : text.has(w) ? 1 : 0;
  return sum / (2 * want.length);
}

/** `found` holds the search results of every slot (by slot id). Slots are filled in order; each clip (by file address) is used once. */
export function planFootage(slots: readonly FootageSlot[], found: ReadonlyMap<string, readonly ClipCandidate[]>): FootagePlan {
  const used = new Set<string>();
  const picks: FootagePick[] = [];
  const unfilled: string[] = [];
  for (const slot of slots) {
    let best: { cand: ClipCandidate; score: number } | undefined;
    for (const cand of found.get(slot.id) ?? []) {
      if (used.has(cand.url)) continue;
      const score = scoreFootage(slot, cand);
      if (score !== null && score >= MIN_SCORE && (!best || score > best.score)) best = { cand, score };
    }
    if (!best) { unfilled.push(slot.id); continue; }
    used.add(best.cand.url);
    picks.push({ slotId: slot.id, ...best, licenceLine: best.cand.credit });
  }
  return { picks, unfilled };
}
