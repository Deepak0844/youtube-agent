import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTestDb, type TestDb } from "../support/db";
import { emitEvent, EventPayloadTooLargeError, listEventsSince, pruneEvents } from "@/server/db/events";
import { createEventBus } from "@/server/queue/event-bus";
import { createEventStream } from "@/server/queue/event-stream";

let db: TestDb;
beforeAll(async () => { db = await withTestDb(); });
afterAll(async () => { await db?.stop(); });
beforeEach(async () => { await db.reset(); });

const V = "11111111-1111-4111-8111-111111111111";
const ev = (n: number) => emitEvent(db.pool, undefined, { type: "log", videoId: V, payload: { n } });

async function collect(opts: { startId: number; ms: number; subscribe?: Parameters<typeof createEventStream>[0]["subscribe"]; during?: () => Promise<void> }) {
  const ac = new AbortController();
  const stream = createEventStream({ startId: opts.startId, signal: ac.signal, fetchSince: (a, l) => listEventsSince(db.pool, a, l), subscribe: opts.subscribe, pollMs: 100 });
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let text = "";
  const pump = (async () => { for (;;) { const x = await reader.read(); if (x.done) return; text += dec.decode(x.value); } })();
  await opts.during?.();
  await new Promise((r) => setTimeout(r, opts.ms));
  ac.abort();
  await pump;
  return [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
}

describe("events table", () => {
  it("event_payload_over_4kb_is_refused", async () => {
    await expect(emitEvent(db.pool, undefined, { type: "log", payload: { big: "word ".repeat(1000) } })).rejects.toBeInstanceOf(EventPayloadTooLargeError);
    // and the database refuses it too, even for a caller that skips the helper
    await expect(db.pool.query("insert into events (type, payload) values ('log', $1::jsonb)", [JSON.stringify({ big: "word ".repeat(1000) })])).rejects.toMatchObject({ code: "23514" });
    expect((await db.pool.query("select count(*)::int n from events")).rows[0].n).toBe(0);
  });

  it("no_event_payload_contains_a_secret_shape", async () => {
    const id = await emitEvent(db.pool, undefined, {
      type: "stage.failed",
      payload: { reason: "call failed with sk-ant-api03-abcdefghijklmnopqrstuvwxyz and Bearer abcdef1234567890abcdef", url: "/api/media/x?e=1790000000&s=AbCdEfGhIjKlMnOpQrStUvWxYz012345678901234", nested: [{ api_key: "hunter2hunter2" }] },
    });
    const [row] = await listEventsSince(db.pool, id - 1);
    const text = JSON.stringify(row!.payload);
    expect(text).not.toMatch(/sk-ant|abcdef1234567890|1790000000|AbCdEfGhIj|hunter2/);
  });

  it("unknown_event_types_are_refused", async () => {
    await expect(emitEvent(db.pool, undefined, { type: "stage.exploded" as never })).rejects.toThrow();
    await expect(db.pool.query("insert into events (type) values ('nope')")).rejects.toMatchObject({ code: "23514" });
  });

  it("the_app_role_cannot_edit_or_delete_events_but_prune_removes_only_week_old_rows", async () => {
    const old = await ev(1);
    await ev(2);
    await db.ownerPool.query("update events set at = now() - interval '8 days' where id = $1", [old]);
    await expect(db.pool.query("delete from events")).rejects.toMatchObject({ code: "42501" });
    await expect(db.pool.query("update events set type = 'log'")).rejects.toMatchObject({ code: "42501" });
    await expect(db.pool.query("truncate events")).rejects.toMatchObject({ code: "42501" });
    expect(await pruneEvents(db.pool)).toBe(1);
    expect((await db.pool.query("select count(*)::int n from events")).rows[0].n).toBe(1);
    expect(await pruneEvents(db.pool)).toBe(0);
  });
});

describe("live feed delivery", () => {
  it("resume_from_last_event_id_has_no_gaps_or_duplicates", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 10; i++) ids.push(await ev(i));
    const first = await collect({ startId: 0, ms: 300 });
    expect(first).toEqual(ids);
    // client saw up to the 4th, reconnects with Last-Event-ID, more arrive while it was away and while it is connected
    for (let i = 10; i < 15; i++) ids.push(await ev(i));
    const resumed = await collect({ startId: ids[3]!, ms: 300, during: async () => { ids.push(await ev(99)); } });
    expect(resumed).toEqual(ids.slice(4));
  });

  it("events_are_delivered_in_id_order_after_a_redis_flushall", async () => {
    const bus = createEventBus(db.redisUrl);
    const seen: number[] = [];
    try {
      const got = await collect({
        startId: 0, ms: 800,
        subscribe: (wake) => bus.subscribe(wake),
        during: async () => {
          seen.push(await emitEvent(db.pool, bus, { type: "log", payload: { n: 1 } }));
          const r = new Redis(db.redisUrl);
          await r.flushall(); // Redis wiped: pub/sub and anything queued is gone
          r.disconnect();
          seen.push(await emitEvent(db.pool, bus, { type: "log", payload: { n: 2 } }));
          seen.push(await emitEvent(db.pool, bus, { type: "log", payload: { n: 3 } }));
        },
      });
      expect(got).toEqual(seen);
      expect([...got].sort((a, b) => a - b)).toEqual(got);
    } finally {
      await bus.close();
    }
  });

  it("the_feed_still_works_when_redis_is_unreachable", async () => {
    const bus = createEventBus("redis://127.0.0.1:1"); // nothing listens here
    try {
      const seen: number[] = [];
      const got = await collect({
        startId: 0, ms: 500,
        subscribe: (wake) => bus.subscribe(wake),
        during: async () => { seen.push(await emitEvent(db.pool, bus, { type: "notify", payload: { n: 1 } })); },
      });
      expect(got).toEqual(seen);
    } finally {
      await bus.close();
    }
  });
});
