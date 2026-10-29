// Pure spend rules. Money is integer micro-USD; token prices are micro-USD per million tokens.
// No IO here (enforced by the lint boundary).

export interface PriceCard {
  inputPerMTokMicro: number;
  outputPerMTokMicro: number;
  cacheWritePerMTokMicro?: number;
  cacheReadPerMTokMicro?: number;
  reasoningPerMTokMicro?: number;
  perCallMicro?: number;
  perImageMicro?: number;
  perVideoSecondMicro?: number;
}

export interface Usage {
  inputTokens: number;
  maxOutputTokens: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  reasoningTokens?: number;
  calls?: number;
  images?: number;
  videoSeconds?: number;
}

// Thrown when a call cannot be priced; callers must refuse the call (fail closed), never guess a price.
export class UnpricedCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnpricedCallError";
  }
}

function nonNegInt(name: string, v: number): bigint {
  if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`${name} must be a non-negative safe integer, got ${v}`);
  return BigInt(v);
}

const MILLION = 1_000_000n;
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

export function worstCaseMicroUsd(card: PriceCard | undefined, usage: Usage): number {
  if (!card) throw new UnpricedCallError("no price card for this call");
  let total = 0n;

  const perMTok = (name: string, tokens: number | undefined, price: number | undefined): void => {
    const t = nonNegInt(name, tokens ?? 0);
    if (price === undefined) {
      if (t > 0n) throw new UnpricedCallError(`no price for ${name}`);
      return;
    }
    total += ceilDiv(t * nonNegInt(`price(${name})`, price), MILLION);
  };
  const flat = (name: string, count: number | undefined, price: number | undefined): void => {
    const n = nonNegInt(name, count ?? 0);
    if (price === undefined) {
      if (n > 0n) throw new UnpricedCallError(`no price for ${name}`);
      return;
    }
    total += n * nonNegInt(`price(${name})`, price);
  };

  perMTok("inputTokens", usage.inputTokens, card.inputPerMTokMicro);
  perMTok("maxOutputTokens", usage.maxOutputTokens, card.outputPerMTokMicro);
  perMTok("cacheWriteTokens", usage.cacheWriteTokens, card.cacheWritePerMTokMicro);
  perMTok("cacheReadTokens", usage.cacheReadTokens, card.cacheReadPerMTokMicro);
  perMTok("reasoningTokens", usage.reasoningTokens, card.reasoningPerMTokMicro);
  flat("calls", usage.calls, card.perCallMicro);
  flat("images", usage.images, card.perImageMicro);
  flat("videoSeconds", usage.videoSeconds, card.perVideoSecondMicro);

  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("worst-case cost exceeds the safe integer range");
  return Number(total);
}

export function callKey(stageRunId: string, stepIndex: number, toolCallIndex: number): string {
  return `${stageRunId}:${stepIndex}:${toolCallIndex}`;
}

// A budget cap in micro-USD. `null` means "no limit": it always allows and is never read as zero (a cap of 0 refuses any spend).
export type Cap = bigint | null;

export function capAllows(cap: Cap, spent: bigint, reserved: bigint, want: bigint): boolean {
  return cap === null || spent + reserved + want <= cap;
}

/** "2", "2.5", "0.0035" (whole dollars, up to 6 decimals) to integer micro-USD; null for anything else (empty, negative, "1e3", "2,5", too long). */
export function dollarsToMicro(text: string): number | null {
  const m = /^(\d{1,7})(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!m) return null;
  return Number(m[1]) * 1_000_000 + Number((m[2] ?? "").padEnd(6, "0"));
}

/** Integer micro-USD to dollars with at least 2 and at most 6 decimals, never rounded to a smaller figure: 2000000 -> "$2.00", 3500 -> "$0.0035". */
export function microToDollars(micro: number): string {
  const whole = Math.floor(micro / 1_000_000);
  const frac = String(micro % 1_000_000).padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `$${whole.toLocaleString("en-US")}.${frac}`;
}
