// Pure price rules for media providers. No IO: SQL lives in src/server/db/media-registry.ts.

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
