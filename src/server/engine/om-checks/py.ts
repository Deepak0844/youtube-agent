// Python's number behaviour, for exact ports of OpenMontage's checks (AGPL-3.0 sources named in each port).

/** Python round(x, digits): halves go to the even neighbour (round(1.25, 1) = 1.2). */
export function pyRound(x: number, digits = 0): number {
  const m = 10 ** digits;
  const v = x * m;
  const fl = Math.floor(v);
  const diff = v - fl;
  const r = Math.abs(diff - 0.5) < 1e-9 ? (fl % 2 === 0 ? fl : fl + 1) : Math.round(v);
  return r / m;
}

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
