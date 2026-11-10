// The long-video thumbnail card (1280x720): pure numbers, no React, unit-tested. The card shows the video's title in big type on its
// look (same palette pick as the video, from the seed) and, when given, one picture on the right.
export const THUMBNAIL_SIZE = { width: 1280, height: 720 } as const;
/** Remotion draws the pop-in animation of the headline until about frame 9; the still is taken after it. */
export const THUMBNAIL_FRAME = 30;
export const THUMBNAIL_FRAMES = 60;
/** At most this many words and characters of the title are drawn: a thumbnail is read at a glance. */
export const THUMBNAIL_MAX_WORDS = 7;
export const THUMBNAIL_MAX_CHARS = 60;

/** Words a shortened title must not end on ("... salty and the"). English only; other scripts are cut at a word. */
const DANGLING = new Set(["a", "an", "and", "or", "but", "the", "of", "to", "in", "on", "at", "for", "with", "is", "are", "was", "were", "that", "than", "as", "by", "from", "how", "why", "what"]);

/** The title as drawn: control characters out, spaces collapsed, cut to a few words (never mid-word, never on a dangling filler word). */
export function thumbnailTitle(title: string | undefined): string {
  const words = (title ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  for (const w of words.slice(0, THUMBNAIL_MAX_WORDS)) {
    if ([...[...kept, w].join(" ")].length > THUMBNAIL_MAX_CHARS) break;
    kept.push(w);
  }
  if (kept.length === 0 && words.length > 0) kept.push([...words[0]!].slice(0, THUMBNAIL_MAX_CHARS).join("")); // one very long word: cut it, do not drop the title
  if (kept.length < words.length) while (kept.length > 1 && DANGLING.has(kept[kept.length - 1]!.toLowerCase().replace(/[^\p{L}]/gu, ""))) kept.pop();
  return kept.join(" ") || "Watch this";
}

/** Type size in px: shorter titles are bigger. The text block is 56% of the card wide with a picture, 88% without. */
export function thumbnailFontSize(text: string, hasPicture: boolean): number {
  const n = [...text].length;
  const base = hasPicture ? 110 : 140;
  return Math.max(64, Math.round(base - Math.max(0, n - 18) * 1.6));
}

export const thumbnailBoxes = (hasPicture: boolean) =>
  hasPicture
    ? { text: { x: 56, y: 60, w: 650, h: 600 }, picture: { x: 740, y: 80, w: 484, h: 560 } }
    : { text: { x: 80, y: 60, w: 1120, h: 600 }, picture: null };
