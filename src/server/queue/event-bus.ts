import { Redis } from "ioredis";

// Redis is only a wake-up for the live feed: PUBLISH carries the event id, never data. If Redis is down, flushed or
// restarted the feed still works from the table (polling), just a little later.
const CHANNEL = "ytstudio:events";

export interface EventBus {
  publish(id: number): Promise<void>;
  /** Calls wake() whenever any process publishes. Returns an unsubscribe. Never throws. */
  subscribe(wake: () => void): () => void;
  close(): Promise<void>;
}

function connection(url: string): Redis {
  // No offline queue and a bounded retry: a Redis outage fails fast instead of buffering or hanging a request.
  const r = new Redis(url, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 1000, retryStrategy: (n) => Math.min(n * 500, 5000) });
  r.on("error", () => {});
  return r;
}

export function createEventBus(url: string): EventBus {
  let pub: Redis | undefined;
  let sub: Redis | undefined;
  const listeners = new Set<() => void>();
  let closed = false;

  const ensureSub = () => {
    if (sub || closed) return;
    const s = (sub = connection(url));
    s.on("message", () => { for (const fn of [...listeners]) { try { fn(); } catch { /* one listener cannot break the others */ } } });
    // ioredis re-subscribes after a reconnect; the first connect and any subscribe failure are retried by the next listener.
    s.connect().then(() => s.subscribe(CHANNEL)).catch(() => { s.disconnect(); if (sub === s) sub = undefined; });
  };

  return {
    async publish(id) {
      if (closed) return;
      try {
        pub ??= connection(url);
        if (pub.status === "wait" || pub.status === "end") await pub.connect();
        await pub.publish(CHANNEL, String(id));
      } catch { /* best effort */ }
    },
    subscribe(wake) {
      listeners.add(wake);
      ensureSub();
      return () => { listeners.delete(wake); };
    },
    async close() {
      closed = true;
      listeners.clear();
      pub?.disconnect();
      sub?.disconnect();
    },
  };
}

// One bus per web process (cached across dev HMR), none when Redis is not configured.
const KEY = Symbol.for("ytstudio.eventBus");
export function getEventBus(): EventBus | undefined {
  const url = process.env.REDIS_URL;
  if (!url) return undefined;
  const g = globalThis as unknown as Record<symbol, EventBus | undefined>;
  return (g[KEY] ??= createEventBus(url));
}
