export interface StreamEvent {
  id: number;
  at: string;
  videoId: string | null;
  stageRunId: string | null;
  type: string;
  payload: unknown;
}

export interface EventStreamOptions {
  /** Rows with id > after, in id order, at most limit. The table is the truth; the bus only says "look now". */
  fetchSince(after: number, limit: number): Promise<StreamEvent[]>;
  /** Last id the client already has. */
  startId: number;
  signal: AbortSignal;
  /** Optional Redis wake-up. Returns an unsubscribe. A dead or flushed Redis only costs latency: polling covers it. */
  subscribe?(wake: () => void): () => void;
  pollMs?: number;
  heartbeatMs?: number;
}

const BATCH = 200;

/** Server-sent events over a plain ReadableStream: replay from startId, then live; comment heartbeat; clean close on abort. */
export function createEventStream(opts: EventStreamOptions): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let last = opts.startId;
  let closed = false;
  let draining = false;
  let again = false;
  let poll: ReturnType<typeof setInterval> | undefined;
  let beat: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;
  let ctl!: ReadableStreamDefaultController<Uint8Array>;

  const send = (s: string) => {
    if (closed) return;
    try { ctl.enqueue(enc.encode(s)); } catch { stop(); }
  };
  const stop = () => {
    if (closed) return;
    closed = true;
    clearInterval(poll);
    clearInterval(beat);
    try { unsubscribe?.(); } catch { /* ignore */ }
    opts.signal.removeEventListener("abort", stop);
    try { ctl.close(); } catch { /* already closed */ }
  };
  // Single flight: a wake-up during a drain schedules exactly one more pass.
  const drain = async () => {
    if (closed) return;
    if (draining) { again = true; return; }
    draining = true;
    try {
      do {
        again = false;
        for (;;) {
          const rows = await opts.fetchSince(last, BATCH);
          if (closed) return;
          for (const r of rows) {
            if (r.id <= last) continue; // never repeat or go backwards
            send(`id: ${r.id}\nevent: ${r.type}\ndata: ${JSON.stringify({ id: r.id, at: r.at, videoId: r.videoId, stageRunId: r.stageRunId, type: r.type, payload: r.payload })}\n\n`);
            last = r.id;
          }
          if (rows.length < BATCH) break;
        }
      } while (again && !closed);
    } catch {
      // A database blip: the next poll tick retries from the same cursor.
    } finally {
      draining = false;
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      ctl = controller;
      if (opts.signal.aborted) return stop();
      opts.signal.addEventListener("abort", stop, { once: true });
      send("retry: 3000\n: connected\n\n");
      beat = setInterval(() => send(": hb\n\n"), opts.heartbeatMs ?? 20_000);
      poll = setInterval(() => void drain(), opts.pollMs ?? 2000);
      try { unsubscribe = opts.subscribe?.(() => void drain()); } catch { /* polling still works */ }
      void drain();
    },
    cancel() { stop(); },
  });
}
