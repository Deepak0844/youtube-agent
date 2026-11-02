// Slideshow-risk check on a built scene list: a warning for the owner, never a block. Pure.
export const SLIDESHOW = { minScenes: 4, maxOneKind: 0.7, maxTextCards: 0.4 } as const;

/** Kinds that are mostly words or numbers on a flat screen. */
export const TEXT_CARD_KINDS: readonly string[] = ["pause_card", "chat_thread", "browser", "spreadsheet"];

type Row = { kind: string; [k: string]: unknown };

const SKIP = new Set(["id", "beat", "startMs", "durationMs"]);
const sig = (s: Row): string => JSON.stringify(Object.fromEntries(Object.entries(s).filter(([k]) => !SKIP.has(k))));

/** Plain-sentence warnings; empty means no slideshow risk. `visuals` are optional per-scene picture briefs. */
export function slideshowRisk(scenes: readonly Row[], visuals: readonly (string | undefined)[] = []): string[] {
  const n = scenes.length;
  if (n < SLIDESHOW.minScenes) return [];
  const out: string[] = [];
  const counts = new Map<string, number>();
  for (const s of scenes) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
  for (const [k, c] of counts) {
    if (c / n > SLIDESHOW.maxOneKind) out.push(`${c} of ${n} scenes are "${k.replace(/_/g, " ")}" (over ${SLIDESHOW.maxOneKind * 100}%). It may feel like a slideshow.`);
  }
  const text = scenes.filter((s) => TEXT_CARD_KINDS.includes(s.kind)).length;
  if (text / n > SLIDESHOW.maxTextCards) out.push(`${text} of ${n} scenes are text or number cards (over ${SLIDESHOW.maxTextCards * 100}%).`);
  const seen = new Set<string>();
  let repeats = 0;
  scenes.forEach((s, i) => {
    const key = visuals[i]?.trim().toLowerCase() || sig(s);
    if (seen.has(key)) repeats++;
    seen.add(key);
  });
  if (repeats > 0) out.push(`${repeats} scene${repeats > 1 ? "s repeat" : " repeats"} an earlier scene's description.`);
  return out;
}
