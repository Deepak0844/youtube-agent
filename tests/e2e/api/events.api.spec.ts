import { expect, test } from "@playwright/test";
import pg from "pg";
import { emitEvent } from "@/server/db/events";
import { endSessionPool, expireSession, mintSession, revokeSession } from "../fixtures/sessions";

// GET /api/events is a long-lived stream outside the proxy: it must check the session and Host itself. The derived
// session-required spec runs the full refusal matrix; these cases add the feed itself (replay, resume, headers) and
// make sure a refusal never carries an event. Streams are read with fetch + AbortController (Playwright's request
// fixture waits for the whole body, which never ends).
const ORIGIN = `http://127.0.0.1:${process.env.E2E_PORT}`;
const MARK = `events-api-marker-${Date.now()}`;
let db: pg.Pool;
const ids: number[] = [];

test.beforeAll(async () => {
  db = new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 2 });
  for (let i = 0; i < 3; i++) ids.push(await emitEvent(db, undefined, { type: "notify", payload: { marker: MARK, n: i } }));
});
test.afterAll(async () => {
  await db.end();
  await endSessionPool();
});

async function read(url: string, headers: Record<string, string>, until: (text: string) => boolean, ms = 8000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(ORIGIN + url, { headers, signal: ac.signal });
    let text = "";
    if (res.status === 200 && res.body) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      while (!until(text)) {
        const x = await reader.read();
        if (x.done) break;
        text += dec.decode(x.value);
      }
    } else {
      text = await res.text();
    }
    ac.abort();
    return { res, text };
  } catch (e) {
    if (ac.signal.aborted) throw new Error("stream read timed out");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
const idsIn = (t: string) => [...t.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));

test("anonymous, forged, expired and revoked sessions get 401 and no event content", async () => {
  const expired = await mintSession();
  await expireSession(expired);
  const revoked = await mintSession();
  await revokeSession(revoked);
  for (const cookie of ["", "ytstudio_session=garbage", `ytstudio_session=${expired}`, `ytstudio_session=${revoked}`]) {
    const { res, text } = await read("/api/events?since=0", cookie ? { cookie } : {}, () => true);
    expect(res.status, cookie).toBe(401);
    expect(text).not.toContain(MARK);
  }
});

test("a valid session gets an event stream that replays from ?since in id order", async () => {
  const cookie = `ytstudio_session=${await mintSession()}`;
  const { res, text } = await read(`/api/events?since=${ids[0]! - 1}`, { cookie }, (t) => idsIn(t).length >= 3);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  expect(res.headers.get("cache-control")).toContain("no-store");
  expect(idsIn(text).slice(0, 3)).toEqual(ids);
  expect(text).toContain(MARK);
});

test("Last-Event-ID resumes after that id with no repeat, and wins over ?since", async () => {
  const cookie = `ytstudio_session=${await mintSession()}`;
  const { text } = await read(`/api/events?since=0`, { cookie, "last-event-id": String(ids[0]) }, (t) => idsIn(t).length >= 2);
  expect(idsIn(text).slice(0, 2)).toEqual([ids[1], ids[2]]);
});

test("a new event is pushed to an open stream", async () => {
  const cookie = `ytstudio_session=${await mintSession()}`;
  const last = ids.at(-1)!;
  const pending = read(`/api/events`, { cookie }, (t) => t.includes("pushed-live"));
  await new Promise((r) => setTimeout(r, 500));
  await emitEvent(db, undefined, { type: "notify", payload: { marker: "pushed-live" } });
  const { text } = await pending;
  expect(text).toContain("pushed-live");
  expect(idsIn(text).every((i) => i > last)).toBe(true); // no ?since: starts at "now", does not replay history
});

test("malformed cursors are 400", async () => {
  const cookie = `ytstudio_session=${await mintSession()}`;
  for (const q of ["?since=abc", "?since=-1", "?since=1e3", `?since=${"9".repeat(40)}`]) {
    expect((await read(`/api/events${q}`, { cookie }, () => true)).res.status, q).toBe(400);
  }
  expect((await read(`/api/events`, { cookie, "last-event-id": "x" }, () => true)).res.status).toBe(400);
});
