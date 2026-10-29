import type { PriceRule } from "@/server/core/media-catalog";

/** safeFetch bound to the typed host api.elevenlabs.io; the per-call options (no redirects, 120 s) are passed by the adapter. */
export type SafeFetch = (url: string, init: RequestInit, opts: { timeoutMs: number; maxRedirects: number }) => Promise<Response>;

/** v3 emotion tags: plain text put before the line. */
export type DeliveryTags = { prefix?: string };

export interface ElevenLabsDeps {
  fetch: SafeFetch;
  /** Decrypted per call; never cached or logged. */
  getKey: () => Promise<string>;
  model: string;
  voiceId: string;
  tags?: DeliveryTags;
  /** The `elevenlabs` registry price (getPriceRule); null = unpriced, refused. */
  price: PriceRule | null;
  budgetScopes: string[];
}

/** Both are billed $0.08 per 1,000 characters, the single registry rule. Flash/Turbo ($0.04) are not supported. */
export const MODELS: ReadonlySet<string> = new Set(["eleven_multilingual_v2", "eleven_v3"]);

export interface Alignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}
