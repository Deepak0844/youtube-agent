import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { syncComments, syncMessage, throttledCommentSync } from "@/server/db/comments";
import { withTestDb, type TestDb } from "../support/db";
import { SESSION, connectChannel, fakeGoogle, ring, uploadedVideo } from "../support/comments-fake";

// Comment sync "Run now": fake Google only, never the real network. Read only; upserts; nothing is retried.

let db: TestDb;
const BY = { kind: "session", sessionId: SESSION } as const;

beforeAll(async () => {
  db = await withTestDb();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
});

describe("comment sync", () => {
  it("reads top-level comments, reserves 1 unit per video, cleans the text, flags risky ones, and is idempotent", async () => {
    const f = fakeGoogle();
    await connectChannel(db, f, true);
    const vid = await uploadedVideo(db);
    f.threads = [
      { id: "Ugx1", text: "Nice video\u0000‮!" },
      { id: "Ugx2", text: "win money at https://evil.example/x" },
      { id: "Ugx3", text: "my own note", authorChannelId: "UCchan1" },
    ];
    const r = await syncComments(db.pool, ring, f.http, BY);
    expect(r).toMatchObject({ videos: 1, newComments: 2, failed: 0, quotaStopped: false, skipped: [] });
    expect((await db.ownerPool.query("select units from quota_usage")).rows.map((x: { units: number }) => Number(x.units))).toEqual([1]);
    const rows = (await db.ownerPool.query("select youtube_comment_id, video_id, text, status, needs_eyes, risk_reasons from comments order by youtube_comment_id")).rows;
    expect(rows).toHaveLength(2); // the channel's own comment is skipped
    expect(rows[0]).toMatchObject({ youtube_comment_id: "Ugx1", video_id: vid, text: "Nice video !", status: "new", needs_eyes: false });
    expect(rows[1]).toMatchObject({ youtube_comment_id: "Ugx2", status: "new", needs_eyes: true });
    expect(rows[1].risk_reasons).toContain("contains a link");
    const again = await syncComments(db.pool, ring, f.http, BY);
    expect(again.newComments).toBe(0);
    expect((await db.ownerPool.query("select count(*)::int as n from comments")).rows[0].n).toBe(2);
    expect(f.posts().filter((c) => c.method === "POST")).toHaveLength(0); // sync never writes to YouTube
    expect((await db.ownerPool.query("select to_char(last_sync_at, 'YYYY') as y from comment_sync_state")).rows[0].y).toMatch(/^\d{4}$/);
    const audit = (await db.ownerPool.query("select event, detail from audit_log where event like 'comments.%'")).rows;
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain("evil.example");
    expect(syncMessage(r)).toContain("2 new comments");
  });

  it("a failed read is counted and not retried; an unconfirmed channel is skipped with a reason", async () => {
    const f = fakeGoogle();
    await connectChannel(db, f, true);
    await uploadedVideo(db);
    f.listStatus = 500;
    const r = await syncComments(db.pool, ring, f.http, BY);
    expect(r).toMatchObject({ videos: 1, failed: 1, newComments: 0 });
    expect(f.calls.filter((c) => c.url.includes("commentThreads"))).toHaveLength(1);
    await db.reset();
    const g = fakeGoogle();
    await connectChannel(db, g, false);
    await uploadedVideo(db);
    const s = await syncComments(db.pool, ring, g.http, BY);
    expect(s.videos).toBe(0);
    expect(s.skipped[0]!.reason).toContain("not confirmed");
    expect(g.calls.filter((c) => c.url.includes("commentThreads"))).toHaveLength(0);
  });

  it("stops when the quota is used up", async () => {
    const f = fakeGoogle();
    await connectChannel(db, f, true);
    await uploadedVideo(db);
    await db.ownerPool.query("insert into quota_usage (day, units) values ((now() at time zone 'America/Los_Angeles')::date, 10000) on conflict (day) do update set units = 10000");
    const r = await syncComments(db.pool, ring, f.http, BY);
    expect(r.quotaStopped).toBe(true);
    expect(f.calls.filter((c) => c.url.includes("commentThreads"))).toHaveLength(0);
  });

  it("the worker hook is throttled by the database (last_sync_at)", async () => {
    const f = fakeGoogle();
    await connectChannel(db, f, true);
    await uploadedVideo(db);
    const queue = { enqueue: async () => undefined } as never;
    const tick = throttledCommentSync(db.pool, ring, f.http, queue, { everyMs: 6 * 3600_000 });
    await tick();
    await throttledCommentSync(db.pool, ring, f.http, queue)(); // a fresh worker object (restart) is held back by the database too
    await tick();
    expect(f.calls.filter((c) => c.url.includes("commentThreads"))).toHaveLength(1);
    await db.ownerPool.query("update comment_sync_state set last_sync_at = now() - interval '7 hours'");
    await tick();
    expect(f.calls.filter((c) => c.url.includes("commentThreads"))).toHaveLength(2);
  });
});
