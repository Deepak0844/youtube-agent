// Keeps consecutive calls to the same hosted model at least `gapMs` apart (free-tier rate limits). In-process only.
// Waiters for one key are served in arrival order; a cancelled waiter rejects at once with the signal's reason.

export interface Pacer {
  wait(key: string, gapMs: number, signal?: AbortSignal): Promise<void>;
}

type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const realSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export function createPacer(now: () => number = Date.now, sleep: Sleep = realSleep): Pacer {
  const keys = new Map<string, { lastStart: number; tail: Promise<void> }>();
  return {
    wait(key, gapMs, signal) {
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (gapMs <= 0) return Promise.resolve();
      const st = keys.get(key) ?? { lastStart: -Infinity, tail: Promise.resolve() };
      keys.set(key, st);
      const mine = st.tail.then(async () => {
        signal?.throwIfAborted(); // cancelled while queued: do not take a slot
        const ms = st.lastStart + gapMs - now();
        if (ms > 0) await sleep(Math.min(ms, gapMs), signal);
        st.lastStart = now();
      });
      st.tail = mine.catch(() => {});
      if (!signal) return mine;
      return Promise.race([
        mine,
        new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
      ]);
    },
  };
}

export const sharedPacer: Pacer = createPacer();
