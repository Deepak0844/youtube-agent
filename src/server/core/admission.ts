// Pure in-process admission control: a global cap and a per-key cap on in-flight work. No queueing: callers that get
// null are refused immediately, so refused work holds no resources (e.g. no database connection).
export interface Admission {
  tryEnter(key: string): (() => void) | null;
  inFlight(): number;
}

export function createAdmission({ maxTotal, maxPerKey }: { maxTotal: number; maxPerKey: number }): Admission {
  if (!Number.isInteger(maxTotal) || maxTotal < 1 || !Number.isInteger(maxPerKey) || maxPerKey < 1) {
    throw new RangeError("maxTotal and maxPerKey must be positive integers");
  }
  let total = 0;
  const perKey = new Map<string, number>();
  return {
    tryEnter(key) {
      const n = perKey.get(key) ?? 0;
      if (total >= maxTotal || n >= maxPerKey) return null;
      total++;
      perKey.set(key, n + 1);
      let released = false;
      return () => {
        if (released) return; // idempotent
        released = true;
        total--;
        const m = (perKey.get(key) ?? 1) - 1;
        if (m <= 0) perKey.delete(key);
        else perKey.set(key, m);
      };
    },
    inFlight: () => total,
  };
}
