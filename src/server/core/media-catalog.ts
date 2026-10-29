// Pure price rules for media providers. No IO: SQL lives in src/server/db/media-registry.ts.
import { microToDollars } from "@/server/core/spend";

export type PriceRule = { unit: "per_1k_chars" | "per_second" | "per_image" | "per_call" | "free"; microUsd: number };

const UNITS = ["per_1k_chars", "per_second", "per_image", "per_call", "free"];

/** A missing or malformed rule is "unpriced" and refused before anything is reserved. */
export function isPriced(rule: unknown): rule is PriceRule {
  if (typeof rule !== "object" || rule === null) return false;
  const { unit, microUsd } = rule as Record<string, unknown>;
  return typeof unit === "string" && UNITS.includes(unit) && Number.isSafeInteger(microUsd) && (microUsd as number) >= 0;
}

/** Integer micro-USD, rounded up. `free` is 0. */
export function quote(rule: PriceRule, quantity: number): number {
  if (!Number.isFinite(quantity) || quantity < 0) throw new RangeError("quantity must be a finite number, 0 or more");
  if (rule.unit === "free") return 0;
  const divisor = rule.unit === "per_1k_chars" ? 1000 : 1;
  const out = Math.ceil(+((rule.microUsd * quantity) / divisor).toFixed(6)); // toFixed drops float noise (1.1*10)
  if (!Number.isSafeInteger(out)) throw new RangeError("quote is too large");
  return out;
}

/** Route scopes in the order the page lists them: everything, per format, per video kind. */
export const SCOPE_LABELS: Record<string, string> = {
  default: "Everything",
  "format:short": "Shorts",
  "format:long": "Long videos",
  "kind:scene_kit": "Scene-kit videos",
  "kind:tsx": "Code-scene videos",
  "kind:collage": "Collage videos",
  "kind:ai": "AI videos",
};
export const routeScope = (s: unknown): string | null => (typeof s === "string" && Object.hasOwn(SCOPE_LABELS, s) ? s : null);

/** The vault key slot of each registry provider; null = no key (free hosted or local). */
export const KEY_SLOT: Record<string, string | null> = {
  elevenlabs: "elevenlabs", elevenlabs_music: "elevenlabs", elevenlabs_sfx: "elevenlabs", edge: null, voicestudio: "voicestudio",
  local_openai: "local_voice", custom_http: "custom", google_tts: "google_tts", azure_tts: "azure_speech", gemini_image: "gemini",
  openai_image: "openai", fal_image: "fal", pexels: "pexels", pixabay: "pixabay", coverr: "coverr", own_stock: null,
};

type Check = { ok: true } | { ok: false; reason: string };

/** A key is needed unless the provider is free or runs on this machine. Fail closed: an unreadable price counts as paid. */
export function canEnable(p: { price: unknown; local: boolean }, hasKey: boolean): Check {
  const free = isPriced(p.price) && p.price.unit === "free";
  return free || p.local || hasKey ? { ok: true } : { ok: false, reason: "Save its key on the Keys page first." };
}

/** A route target must be switched on and have a price (fail closed: no price, no route). */
export function canRoute(p: { enabled: boolean; price: unknown }): Check {
  if (!p.enabled) return { ok: false, reason: "Switch the provider on first." };
  return isPriced(p.price) ? { ok: true } : { ok: false, reason: "Its price is not set, so it cannot be used." };
}

/** "free", "price not set", or "about $x.xx" for a typical short: 100 words (600 characters), 30 s of audio, 1 image or call. */
export function priceLabel(price: unknown): string {
  if (!isPriced(price)) return "price not set";
  if (price.unit === "free") return "free";
  return `about ${microToDollars(quote(price, price.unit === "per_1k_chars" ? 600 : price.unit === "per_second" ? 30 : 1))}`;
}
