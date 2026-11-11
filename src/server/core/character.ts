// A locked character (Phase 8.6): the library picture every clip of an AI video starts from. Pure rules, no IO.
export const MIN_CHARACTER_SIDE = 300;

export interface CharacterAsset {
  kind: string;
  mime: string;
  width: number | null;
  height: number | null;
  deleted: boolean;
}

/** Why this picture cannot be a character, or null. The limits are the strictest of the video models (a clip's start picture: 300 px or more, shape between 2:5 and 5:2, PNG or JPEG). */
export function characterProblem(a: CharacterAsset): string | null {
  if (a.deleted) return "That picture was deleted from the library.";
  if (a.kind !== "image") return "A character has to be a picture.";
  if (a.mime !== "image/png" && a.mime !== "image/jpeg") return "A character picture has to be a PNG or JPEG.";
  if (!a.width || !a.height) return "The picture's size is not known.";
  if (Math.min(a.width, a.height) < MIN_CHARACTER_SIDE) return `A character picture has to be at least ${MIN_CHARACTER_SIDE} pixels on each side.`;
  const ratio = a.width / a.height;
  if (ratio < 0.4 || ratio > 2.5) return "A character picture can be at most 2.5 times wider than tall, or the other way round.";
  return null;
}
