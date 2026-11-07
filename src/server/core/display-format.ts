// Display-only money and time. Stored amounts and spend caps stay in micro-USD; the rupee figure is a rate-based hint.

export const DEFAULT_INR_RATE = 95.05;

/** Micro-USD to "$1.23 (₹116.9)". A missing or invalid rate shows dollars only. */
export function formatMoney(microUsd: number, rate: number | null | undefined = null): string {
  const usd = `$${(Math.round(microUsd / 10_000) / 100).toFixed(2)}`;
  if (rate === null || rate === undefined || !Number.isFinite(rate) || rate <= 0) return usd;
  const inr = Math.round((microUsd / 1_000_000) * rate * 10) / 10;
  return `${usd} (₹${inr.toLocaleString("en-IN", { minimumFractionDigits: 1, maximumFractionDigits: 1 })})`;
}

const IST = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** "2026-03-04 10:36 IST" (Asia/Kolkata, UTC+5:30, no daylight saving). */
export function formatIst(d: Date, withSeconds = false): string {
  const p = Object.fromEntries(IST.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}${withSeconds ? `:${p.second}` : ""} IST`;
}
