import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventStream, type StreamEvent } from "@/server/queue/event-stream";

const ev = (id: number): StreamEvent => ({ id, at: "2026-10-27T00:00:00.000Z", videoId: null, stageRunId: null, type: "log", payload: { n: id } });

function reader(stream: ReadableStream<Uint8Array>) {
  const r = stream.getReader();
  const dec = new TextDecoder();
  const chunks: string[] = [];
  let done = false;
  void (async () => { for (;;) { const x = await r.read(); if (x.done) { done = true; return; } chunks.push(dec.decode(x.value)); } })();
  return { text: () => chunks.join(""), isDone: () => done };
}

describe("createEventStream", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("heartbeat_arrives_within_21s", async () => {
    const ac = new AbortController();
    const s = reader(createEventStream({ fetchSince: async () => [], startId: 0, signal: ac.signal }));
    await vi.advanceTimersByTimeAsync(21_000);
    expect(s.text()).toContain(": hb");
    ac.abort();
    await vi.advanceTimersByTimeAsync(10);
    expect(s.isDone()).toBe(true);
  });

  it("polls_when_there_is_no_bus_and_sends_each_event_once_in_order", async () => {
    const rows = [ev(1), ev(2), ev(3)];
    let visible = 1;
    const ac = new AbortController();
    const s = reader(createEventStream({
      fetchSince: async (after) => rows.filter((r) => r.id > after && r.id <= visible),
      startId: 0, signal: ac.signal,
    }));
    await vi.advanceTimersByTimeAsync(2100);
    visible = 3;
    await vi.advanceTimersByTimeAsync(2100);
    const ids = [...s.text().matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(ids).toEqual([1, 2, 3]);
    ac.abort();
  });

  it("a_bus_wake_up_delivers_without_waiting_for_the_poll", async () => {
    let wake: () => void = () => {};
    let visible = 0;
    const ac = new AbortController();
    const s = reader(createEventStream({
      fetchSince: async (after) => [ev(1)].filter((r) => r.id > after && r.id <= visible),
      startId: 0, signal: ac.signal,
      subscribe: (fn) => { wake = fn; return () => {}; },
    }));
    await vi.advanceTimersByTimeAsync(50);
    visible = 1;
    wake();
    await vi.advanceTimersByTimeAsync(50);
    expect(s.text()).toContain("id: 1");
    ac.abort();
  });

  it("closes_cleanly_and_stops_polling_on_abort", async () => {
    const ac = new AbortController();
    let n = 0;
    const s = reader(createEventStream({ fetchSince: async () => { n++; return []; }, startId: 0, signal: ac.signal }));
    await vi.advanceTimersByTimeAsync(2100);
    ac.abort();
    await vi.advanceTimersByTimeAsync(10);
    const after = n;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(n).toBe(after);
    expect(s.isDone()).toBe(true);
  });

  it("a_failing_fetch_does_not_kill_the_stream", async () => {
    let fail = true;
    const ac = new AbortController();
    const s = reader(createEventStream({
      fetchSince: async (after) => { if (fail) throw new Error("db blip"); return [ev(1)].filter((r) => r.id > after); },
      startId: 0, signal: ac.signal,
    }));
    await vi.advanceTimersByTimeAsync(2100);
    fail = false;
    await vi.advanceTimersByTimeAsync(2100);
    expect(s.text()).toContain("id: 1");
    ac.abort();
  });
});
