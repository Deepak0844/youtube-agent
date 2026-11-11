// Pure rules for AI video clips (Phase 8): what a model can do, whether a request is allowed, what it costs. No IO.
// Prices are always the owner's own per-second number from the provider registry; nothing here knows a real price. The helpers
// below only turn a provider's published rate (for example Seedance's price per million tokens) into that per-second number.
import { KnownFailure } from "@/server/core/paid-call";
import { isPriced, quote, type PriceRule } from "@/server/core/media-catalog";

export type ClipAspect = "9:16" | "16:9" | "1:1";
export const CLIP_ASPECTS: readonly ClipAspect[] = ["9:16", "16:9", "1:1"];
export const MAX_CLIP_PROMPT = 2000;

export interface VideoModelCap {
  /** The model's own name at the provider, for example "veo-3.1-fast". Each speed or quality tier is its own model with its own price. */
  id: string;
  /** Can start from a picture. A locked character needs this: the character is never re-drawn from words. */
  imageToVideo: boolean;
  /** Can also be told the last picture (used to loop the end back to the start). */
  endFrame: boolean;
  /** Makes its own sound track. We always ask for it off, because the voice and sound are made elsewhere. */
  audio: boolean;
  /** true = cannot make a clip from words alone: a start picture is always needed. */
  imageRequired?: boolean;
  aspects: readonly ClipAspect[];
  minSeconds: number;
  maxSeconds: number;
  /** When set, only these lengths are allowed (Veo makes 4, 6 or 8 seconds). */
  allowedSeconds?: readonly number[];
}

export interface ClipRequest {
  prompt: string;
  seconds: number;
  aspect: ClipAspect;
  /** true when a start picture is given (the adapter's caller resolves the file) */
  startImage: boolean;
  endImage: boolean;
}

/** Plain text: control characters removed and trimmed; null when empty or too long. */
export function cleanClipPrompt(raw: string): string | null {
  const t = raw.replace(/\p{Cc}/gu, "").trim();
  return t === "" || Array.from(t).length > MAX_CLIP_PROMPT ? null : t;
}

/** The first reason this request cannot go to this model, or null. Checked before any money is reserved. */
export function clipProblem(cap: VideoModelCap, r: ClipRequest): string | null {
  if (cleanClipPrompt(r.prompt) === null) return `A clip needs a description of 1 to ${MAX_CLIP_PROMPT} characters.`;
  if (!cap.aspects.includes(r.aspect)) return `${cap.id} cannot make this video shape.`;
  if (!Number.isFinite(r.seconds) || !Number.isInteger(r.seconds)) return "A clip length must be a whole number of seconds.";
  if (r.seconds < cap.minSeconds || r.seconds > cap.maxSeconds) return `${cap.id} makes clips of ${cap.minSeconds} to ${cap.maxSeconds} seconds.`;
  if (cap.imageRequired && !r.startImage) return `${cap.id} needs a start picture.`;
  if (cap.allowedSeconds && !cap.allowedSeconds.includes(r.seconds)) return `${cap.id} makes clips of ${cap.allowedSeconds.join(", ")} seconds.`;
  if (r.startImage && !cap.imageToVideo) return `${cap.id} cannot start from a picture.`;
  if (r.endImage && (!cap.endFrame || !r.startImage)) return `${cap.id} cannot be given an end picture.`;
  return null;
}

/** Price of one clip: the owner's per-second price times the length, rounded up. Unpriced = refused (fail closed). */
export function quoteClip(price: unknown, seconds: number): number {
  if (!isPriced(price) || (price as PriceRule).unit !== "per_second") throw new KnownFailure("This video model has no per-second price set, so it cannot be used.");
  return quote(price as PriceRule, seconds);
}

/** A locked character is never drawn from words: only a model that can start from a picture may be used for it. */
export function lockedCharacterProblem(cap: VideoModelCap): string | null {
  return cap.imageToVideo ? null : `${cap.id} cannot start from a picture, so it cannot keep a character's look.`;
}

// Derived prices ------------------------------------------------------------------------------------------------

/** Seedance bills in tokens: width x height x frames per second x seconds / 1024. */
export function seedanceTokens(d: { width: number; height: number; fps: number; seconds: number }): number {
  return Math.ceil((d.width * d.height * d.fps * d.seconds) / 1024);
}

/** Per-second micro-USD from a published price per million tokens at a fixed size and frame rate (rounded up). Use it to fill the registry price. */
export function microPerSecondFromTokenRate(microUsdPerMillionTokens: number, d: { width: number; height: number; fps: number }): number {
  return Math.ceil((microUsdPerMillionTokens * seedanceTokens({ ...d, seconds: 1 })) / 1_000_000);
}
