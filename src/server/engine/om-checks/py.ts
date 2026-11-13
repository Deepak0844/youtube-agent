// Python's number behaviour, for exact ports of OpenMontage's checks (AGPL-3.0 sources named in each port).

/**
 * Python's rounding of a float to `digits` decimals, as text: the exact binary value decides, and an exact half goes to the
 * even neighbour (f"{12.125:.2f}" = "12.12", but 1.015 is really 1.01499... so it gives "1.01").
 */
export function pyFixed(x: number, digits: number): string {
  if (!Number.isFinite(x)) return String(x);
  const [ip, fp = ""] = Math.abs(x).toFixed(Math.min(100, digits + 30)).split(".");
  const keep = fp.slice(0, digits);
  const rest = fp.slice(digits);
  const last = Number((keep || ip!).slice(-1));
  const up = rest[0]! > "5" || (rest[0] === "5" && (/[1-9]/.test(rest.slice(1)) || last % 2 === 1));
  const n = (BigInt(ip! + keep) + (up ? 1n : 0n)).toString().padStart(digits + 1, "0");
  const text = digits > 0 ? `${n.slice(0, -digits)}.${n.slice(-digits)}` : n;
  return x < 0 && /[1-9]/.test(text) ? `-${text}` : text;
}

/** Python round(x, digits). */
export const pyRound = (x: number, digits = 0): number => Number(pyFixed(x, digits));

/** Python f"{x:.0%}". */
export const pyPercent = (x: number): string => `${pyRound(x * 100)}%`;

/** Python truthiness of a JSON value. */
export function pyTruthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object" && v !== null) return Object.keys(v).length > 0;
  return Boolean(v);
}

/** collections.Counter(values).most_common(1)[0]: the most frequent value, first seen wins a tie. */
export function mostCommon<T>(values: T[]): [T, number] {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: [T, number] = [values[0]!, 0];
  for (const [v, n] of counts) if (n > best[1]) best = [v, n];
  return best;
}

/** dict.get(key, fallback) on a JSON object: the fallback only when the key is absent (a null value stays null). */
export function pyGet(o: unknown, key: string, fallback: unknown): unknown {
  return typeof o === "object" && o !== null && !Array.isArray(o) && Object.hasOwn(o, key) ? (o as Record<string, unknown>)[key] : fallback;
}
