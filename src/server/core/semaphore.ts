// Tiny async semaphore (pure). Used to cap concurrent scrypt work (each hash needs ~128 MiB).
export interface Semaphore {
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Every slot is taken (a run() now would wait). */
  busy(): boolean;
}

export function createSemaphore(max: number): Semaphore {
  if (!Number.isInteger(max) || max < 1) throw new RangeError("max must be a positive integer");
  let active = 0;
  const waiting: Array<() => void> = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next(); // hand the slot straight to the next waiter (active stays the same)
    else active--;
  };
  return {
    busy: () => active >= max,
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (active < max) active++;
      else await new Promise<void>((r) => waiting.push(r));
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}
