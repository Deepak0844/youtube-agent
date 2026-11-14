import { formatIst } from "./display-format";
import { istParts } from "./scheduler";

// The USD to INR display rate (owner 2026-11-14): fetched once a day from a free public rate service. No AI, no account, no
// browser: a plain request to a documented address. Pure: no IO. The rate only changes what is shown; stored amounts and spend
// caps stay in dollars.

export const FX_SOURCES = [
  { id: "frankfurter", url: "https://api.frankfurter.dev/v1/latest?base=USD&symbols=INR", credit: "Frankfurter (European Central Bank daily rates)" },
  { id: "open-er-api", url: "https://open.er-api.com/v6/latest/USD", credit: "open.er-api.com (exchangerate-api.com)" },
] as const;
export type FxSourceId = (typeof FX_SOURCES)[number]["id"];

export interface FxMeta {
  source: FxSourceId | string;
  /** The date the service says the rate is for (yyyy-mm-dd). */
  rateDate: string;
  /** When this app fetched it (ISO time). */
  fetchedAt: string;
}

/** Rupees per dollar outside this range is a misread number or a bad answer, not a rate. */
export const RATE_MIN = 50;
export const RATE_MAX = 200;
export const rateInRange = (r: number): boolean => Number.isFinite(r) && r >= RATE_MIN && r <= RATE_MAX;

export const FX_FROM_HOUR_IST = 9;

const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The rate and its date from a service's answer, or null when the answer is not exactly the documented shape. */
export function parseFxAnswer(source: FxSourceId, text: string): { rate: number; rateDate: string } | null {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  const o = obj(j);
  const inr = obj(o.rates).INR;
  if (typeof inr !== "number" || !(inr > 0)) return null;
  if (source === "frankfurter") {
    if (o.base !== "USD" || typeof o.date !== "string" || !DAY.test(o.date)) return null;
    return { rate: round4(inr), rateDate: o.date };
  }
  if (o.result !== "success" || o.base_code !== "USD") return null;
  const t = typeof o.time_last_update_utc === "string" ? Date.parse(o.time_last_update_utc) : NaN;
  if (!Number.isFinite(t)) return null;
  return { rate: round4(inr), rateDate: new Date(t).toISOString().slice(0, 10) };
}

/** Whether the daily refresh should run now: switched on, from 09:00 IST, and not yet fetched on this IST day. */
export function fxRefreshDue(now: Date, meta: FxMeta | null, auto: boolean): boolean {
  if (!auto) return false;
  const { date, hour } = istParts(now);
  if (hour < FX_FROM_HOUR_IST) return false;
  if (!meta) return true;
  const last = Date.parse(meta.fetchedAt);
  return !Number.isFinite(last) || istParts(new Date(last)).date !== date;
}

/** "From Frankfurter (...), rate of 2026-11-13, fetched 2026-11-14 10:30 IST." */
export function fxNote(meta: FxMeta): string {
  const credit = FX_SOURCES.find((s) => s.id === meta.source)?.credit ?? meta.source;
  const at = Date.parse(meta.fetchedAt);
  return `From ${credit}, rate of ${meta.rateDate}${Number.isFinite(at) ? `, fetched ${formatIst(new Date(at))}` : ""}.`;
}
