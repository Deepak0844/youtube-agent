// The cost plan a video's Build stage writes and the owner approves at the cost gate. Pure: no IO. Money is integer
// micro-USD end to end; the quote travels as a decimal STRING in the stored body so it never passes through a float.
//
// The body carries the fields the cost gate hashes (providers_models, path, library_scene_versions, quote; see
// core/approvals.ts) plus the item list Generate works through. Changing a provider or a price changes the body, so the
// approval is void and the gate opens again.

export const COST_PATHS = ["scene_kit", "tsx", "collage", "ai"] as const;
export type CostPath = (typeof COST_PATHS)[number];

export const ITEM_KINDS = ["image", "clip"] as const;
export interface CostItem {
  kind: (typeof ITEM_KINDS)[number];
  provider: string;
  quoteMicroUsd: number;
}
export interface CostPlan {
  items: CostItem[];
  path: CostPath;
  totalMicroUsd: number;
}

const isMicro = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** Sum of whole micro-USD amounts. Throws RangeError on anything that is not a non-negative safe integer, or on overflow. */
export function sumMicroUsd(values: readonly number[]): number {
  let total = 0n;
  for (const v of values) {
    if (!isMicro(v)) throw new RangeError(`not a whole, non-negative micro-USD amount: ${String(v)}`);
    total += BigInt(v);
  }
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("micro-USD total is too large");
  return Number(total);
}

export function buildCostPlan(items: readonly CostItem[], path: CostPath): CostPlan {
  if (!(COST_PATHS as readonly string[]).includes(path)) throw new RangeError("unknown cost path");
  for (const i of items) {
    if (!(ITEM_KINDS as readonly string[]).includes(i.kind)) throw new RangeError("unknown cost item kind");
    if (typeof i.provider !== "string" || i.provider.trim() === "") throw new RangeError("a cost item needs a provider");
  }
  const totalMicroUsd = sumMicroUsd(items.map((i) => i.quoteMicroUsd));
  return { items: items.map((i) => ({ kind: i.kind, provider: i.provider, quoteMicroUsd: i.quoteMicroUsd })), path, totalMicroUsd };
}

export interface CostPlanBody extends CostPlan {
  providers_models: Record<string, string>;
  library_scene_versions: Record<string, never>;
  quote: { micro_usd: string };
}

/** What gets stored as the `cost_plan` content body. providers_models: item kind -> its providers (sorted, comma joined). */
export function costPlanBody(plan: CostPlan): CostPlanBody {
  const byKind = new Map<string, Set<string>>();
  for (const i of plan.items) byKind.set(i.kind, (byKind.get(i.kind) ?? new Set()).add(i.provider));
  const providers_models: Record<string, string> = {};
  for (const [kind, set] of [...byKind.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) providers_models[kind] = [...set].sort().join(",");
  return { ...plan, providers_models, library_scene_versions: {}, quote: { micro_usd: String(plan.totalMicroUsd) } };
}

export type ParsedCostPlan = { ok: true; plan: CostPlan; quoteMicroUsd: number } | { ok: false; reason: string };
const bad = (reason: string): ParsedCostPlan => ({ ok: false, reason });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads a stored body back. Every figure is re-checked: items must add up to the total, and must not exceed the quote. */
export function parseCostPlan(body: unknown): ParsedCostPlan {
  if (!isObj(body)) return bad("the cost plan is not readable");
  const { items, path, totalMicroUsd, quote } = body;
  if (!(COST_PATHS as readonly string[]).includes(path as string)) return bad("the cost plan has an unknown path");
  if (!Array.isArray(items)) return bad("the cost plan has no item list");
  if (!isObj(quote) || typeof quote.micro_usd !== "string" || !/^[0-9]{1,16}$/.test(quote.micro_usd)) return bad("the cost plan quote is not a whole number of micro-USD");
  const quoteMicroUsd = Number(quote.micro_usd);
  if (!Number.isSafeInteger(quoteMicroUsd)) return bad("the cost plan quote is too large");
  const parsed: CostItem[] = [];
  for (const raw of items) {
    if (!isObj(raw) || !(ITEM_KINDS as readonly string[]).includes(raw.kind as string)) return bad("a cost item has an unknown kind");
    if (typeof raw.provider !== "string" || raw.provider.trim() === "") return bad("a cost item has no provider");
    if (!isMicro(raw.quoteMicroUsd)) return bad("a cost item price is not a whole number of micro-USD");
    parsed.push({ kind: raw.kind as CostItem["kind"], provider: raw.provider, quoteMicroUsd: raw.quoteMicroUsd });
  }
  let total: number;
  try {
    total = sumMicroUsd(parsed.map((i) => i.quoteMicroUsd));
  } catch {
    return bad("the cost plan total is too large");
  }
  if (totalMicroUsd !== total) return bad("the cost plan total does not match its items");
  if (total > quoteMicroUsd) return bad("the cost plan items cost more than the approved quote");
  return { ok: true, plan: { items: parsed, path: path as CostPath, totalMicroUsd: total }, quoteMicroUsd };
}

/** What is left of a quote after money reserved and spent against it. Never below zero. */
export function quoteHeadroom(quoteMicroUsd: number, reservedMicroUsd: number, spentMicroUsd: number): number {
  return Math.max(0, quoteMicroUsd - reservedMicroUsd - spentMicroUsd);
}
