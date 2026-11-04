import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ACTOR_REASON } from "@/server/core/approvals";
import { seenHash } from "@/server/core/comments";
import * as commentsModule from "@/server/db/comments";
import { editReply, ignoreComment, loadEngagement, postReply, resolveReply, saveDrafts, syncComments } from "@/server/db/comments";
import { saveUploadSwitches } from "@/server/db/system-settings";
import { withTestDb, type TestDb } from "../support/db";
import { SESSION, connectChannel, fakeGoogle, ring, uploadedVideo, type Fake } from "../support/comments-fake";

// Posting a reply. Fake Google only, never the real network. The human-gate rule: only the owner session posts, one reply at a time.

let db: TestDb;
const ACTOR = { kind: "session", sessionId: SESSION } as const;
const NO_GAP = { repliesPerDay: 10, secondsBetweenReplies: 0 };
const DEFAULT_POLICY = { repliesPerDay: 10, secondsBetweenReplies: 90 };
let mode: "dry" | "live" = "dry";

beforeAll(async () => {
  db = await withTestDb();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  mode = "dry";
});

interface Seed { f: Fake; vid: string; ids: string[]; seenOf: (i: number) => Promise<string> }

/** A confirmed channel, an uploaded video, `texts.length` synced comments, each with a HELD draft "Reply i". */
async function seed(texts: string[] = ["Great video!"]): Promise<Seed> {
  const f = fakeGoogle();
  await connectChannel(db, f, true);
  const vid = await uploadedVideo(db);
  f.threads = texts.map((text, i) => ({ id: `Ugx${i}`, text }));
  await syncComments(db.pool, ring, f.http, { kind: "session", sessionId: SESSION });
  await saveDrafts(db.pool, vid, new Map(texts.map((_t, i) => [`Ugx${i}`, `Reply ${i}`])));
  f.calls.length = 0;
  await db.ownerPool.query("truncate quota_usage"); // syncing spent a unit; the tests below count their own
  const ids = (await db.ownerPool.query("select r.id from comment_replies r join comments c on c.id = r.comment_id order by c.youtube_comment_id")).rows.map((r: { id: string }) => r.id);
  const seenOf = async (i: number) => {
    const r = (await db.ownerPool.query("select c.text as ctext, r.draft_text from comment_replies r join comments c on c.id = r.comment_id where r.id = $1", [ids[i]])).rows[0];
    return seenHash(r.ctext, r.draft_text);
  };
  return { f, vid, ids, seenOf };
}

const goLive = async () => {
  const r = await saveUploadSwitches(db.pool, { commentsDryRun: false, typedLive: "POST FOR REAL" });
  if (r.ok) mode = "live";
  return r;
};
const reply = async (id: string) => (await db.ownerPool.query("select * from comment_replies where id = $1", [id])).rows[0];
const audits = async (prefix: string) => (await db.ownerPool.query("select event, detail from audit_log where event like $1", [`${prefix}%`])).rows;

describe("who may post (human-gate rule)", () => {
  it("refuses the agent, a token, a bare session id and no actor, before anything changes or is sent", async () => {
    const { f, ids, seenOf } = await seed();
    await goLive();
    const seen = await seenOf(0);
    for (const actor of [undefined, null, { kind: "token" }, { kind: "agent", sessionId: SESSION }, { kind: "session" }, { kind: "session", sessionId: "not-a-uuid" }, { kind: "session", sessionId: SESSION, extra: 1 }, "session"]) {
      const r = await postReply(db.pool, ring, f.http, { replyId: ids[0]!, seen, expectMode: "live", actor: actor as never }, { policy: NO_GAP });
      expect(r, JSON.stringify(actor)).toEqual({ ok: false, message: ACTOR_REASON });
      expect(await editReply(db.pool, ids[0]!, "new text", actor as never)).toEqual({ ok: false, message: ACTOR_REASON });
      expect(await ignoreComment(db.pool, ids[0]!, actor as never)).toEqual({ ok: false, message: ACTOR_REASON });
    }
    expect(f.calls).toEqual([]);
    expect((await reply(ids[0]!)).status).toBe("held");
    expect((await reply(ids[0]!)).attempted_at).toBeNull();
  });

  it("has no bulk approve or post-all entry point", () => {
    expect(Object.keys(commentsModule).filter((k) => /bulk|all|many|batch/i.test(k))).toEqual([]);
  });
});

describe("dry run is the default", () => {
  it("records the request that would be sent and calls Google not at all", async () => {
    const { f, ids, seenOf } = await seed();
    expect((await loadEngagement(db.pool)).dryRun).toBe(true);
    const r = await postReply(db.pool, ring, f.http, { replyId: ids[0]!, seen: await seenOf(0), expectMode: mode, actor: ACTOR }, { policy: DEFAULT_POLICY });
    expect(r).toEqual({ ok: true, outcome: "dry_run" });
    expect(f.calls).toEqual([]);
    const row = await reply(ids[0]!);
    expect(row).toMatchObject({ status: "dry_run", mode: "dry", approved_by_session: SESSION, posted_youtube_id: null });
    expect(row.would_send).toMatchObject({ method: "POST", parentId: "Ugx0", text: "Reply 0" });
    expect(row.approved_hash).toBe(await seenOf(0));
    expect((await audits("comment.reply_dry_run")).length).toBe(1);
    expect((await db.ownerPool.query("select count(*)::int as n from quota_usage")).rows[0].n).toBe(0);
  });
});

describe("live posting (dry run turned off by the owner)", () => {
  it("posts the exact reply text under the comment, reserves 50 units first, and records the YouTube id", async () => {
    const { f, ids, seenOf } = await seed();
    expect(await goLive()).toMatchObject({ ok: true });
    expect((await audits("setting.changed")).some((a) => a.detail.setting === "comments.dry_run" && a.detail.to === false)).toBe(true);
    const r = await postReply(db.pool, ring, f.http, { replyId: ids[0]!, seen: await seenOf(0), expectMode: mode, actor: ACTOR }, { policy: DEFAULT_POLICY, quotaBudget: 8000 });
    expect(r).toEqual({ ok: true, outcome: "posted" });
    const posts = f.posts();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.method).toBe("POST");
    expect(JSON.parse(posts[0]!.body!)).toEqual({ snippet: { parentId: "Ugx0", textOriginal: "Reply 0" } });
    expect((await db.ownerPool.query("select units from quota_usage")).rows.map((x: { units: number }) => Number(x.units))).toEqual([50]);
    expect(await reply(ids[0]!)).toMatchObject({ status: "posted", mode: "live", posted_youtube_id: "UgyPosted1", error: null });
    expect((await db.ownerPool.query("select status from comments")).rows[0].status).toBe("posted");
    expect((await audits("comment.reply_posted")).length).toBe(1);
  });

  it("an approval is bound to the exact text the owner saw: an edit after opening voids it", async () => {
    const { f, ids, seenOf } = await seed();
    await goLive();
    const seen = await seenOf(0);
    expect(await editReply(db.pool, ids[0]!, "A different answer", ACTOR)).toEqual({ ok: true });
    const r = await postReply(db.pool, ring, f.http, { replyId: ids[0]!, seen, expectMode: mode, actor: ACTOR }, { policy: NO_GAP });
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/changed after you opened/) });
    expect(f.calls).toEqual([]);
    expect((await reply(ids[0]!)).status).toBe("held");
    // the new text, seen anew, can be posted
    expect(await postReply(db.pool, ring, f.http, { replyId: ids[0]!, seen: await seenOf(0), expectMode: mode, actor: ACTOR }, { policy: NO_GAP })).toMatchObject({ ok: true });
    expect(JSON.parse(f.posts()[0]!.body!).snippet.textOriginal).toBe("A different answer");
  });

  it("editing a dry-run reply voids its approval and puts it back to held", async () => {
    const { f, ids, seenOf } = await seed();
    await postReply(db.pool, ring, f.http, { replyId: ids[0]!, seen: await seenOf(0), expectMode: mode, actor: ACTOR }, { policy: DEFAULT_POLICY });
    expect((await reply(ids[0]!)).status).toBe("dry_run");
    await editReply(db.pool, ids[0]!, "Edited", ACTOR);
    expect(await reply(ids[0]!)).toMatchObject({ status: "held", approved_hash: null, approved_by_session: null, attempted_at: null, would_send: null });
  });

  it("a comment that needs your eyes is posted only with the tick, and a comment changed by its author after drafting voids the view", async () => {
    const { f, ids, seenOf } = await seed(["visit https://evil.example today"]);
    await goLive();
    const seen = await seenOf(0);
    expect(await postReply(db.pool, ring, f.http, { replyId: ids[0]!, seen, expectMode: mode, actor: ACTOR }, { policy: NO_GAP })).toMatchObject({ ok: false, message: expect.stringMatching(/needs your eyes/) });
    expect(f.calls).toEqual([]);
    f.threads = [{ id: "Ugx0", text: "visit https://evil.example today, edited" }];
    await syncComments(db.pool, ring, f.http, { kind: "session", sessionId: SESSION });
    f.calls.length = 0;
    expect(await postReply(db.pool, ring, f.http, { replyId: ids[0]!, seen, ack: true, expectMode: mode, actor: ACTOR }, { policy: NO_GAP })).toMatchObject({ ok: false, message: expect.stringMatching(/changed after you opened/) });
    expect(await postReply(db.pool, ring, f.http, { replyId: ids[0]!, seen: await seenOf(0), ack: true, expectMode: mode, actor: ACTOR }, { policy: NO_GAP })).toMatchObject({ ok: true, outcome: "posted" });
  });

  it("the kill switch blocks posting, and so does a channel that is not connected and confirmed", async () => {
    const { f, ids, seenOf } = await seed();
    await goLive();
    await saveUploadSwitches(db.pool, { killSwitch: true });
    expect(await postReply(db.pool, ring, f.http, { replyId: ids[0]!, seen: await seenOf(0), expectMode: mode, actor: ACTOR }, { policy: NO_GAP })).toMatchObject({ ok: false, message: expect.stringMatching(/kill switch/) });
    await saveUploadSwitches(db.pool, { killSwitch: false });
    await db.ownerPool.query("update youtube_channels set status = 'needs_reconnect'");
    expect(await postReply(db.pool, ring, f.http, { replyId: ids[0]!, seen: await seenOf(0), expectMode: mode, actor: ACTOR }, { policy: NO_GAP })).toMatchObject({ ok: false, message: expect.stringMatching(/connected and confirmed/) });
    await db.ownerPool.query("update youtube_channels set status = 'unconfirmed'");
    expect(await postReply(db.pool, ring, f.http, { replyId: ids[0]!, seen: await seenOf(0), expectMode: mode, actor: ACTOR }, { policy: NO_GAP })).toMatchObject({ ok: false });
    expect(f.calls).toEqual([]);
    expect((await reply(ids[0]!)).status).toBe("held");
  });

  it("not enough quota puts the reply back to held and sends nothing", async () => {
    const { f, ids, seenOf } = await seed();
    await goLive();
    await db.ownerPool.query("insert into quota_usage (day, units) values ((now() at time zone 'America/Los_Angeles')::date, 7990) on conflict (day) do update set units = 7990");
    const r = await postReply(db.pool, ring, f.http, { replyId: ids[0]!, seen: await seenOf(0), expectMode: mode, actor: ACTOR }, { policy: NO_GAP, quotaBudget: 8000 });
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/quota.*Nothing was posted/) });
    expect(f.posts()).toHaveLength(0);
    expect(await reply(ids[0]!)).toMatchObject({ status: "held", attempted_at: null, mode: null });
  });
});

describe("limits on the database clock", () => {
  it("allows only repliesPerDay a day per channel", async () => {
    const { f, ids, seenOf } = await seed(["a", "b", "c"]);
    await goLive();
    const policy = { repliesPerDay: 2, secondsBetweenReplies: 0 };
    expect(await postReply(db.pool, ring, f.http, { replyId: ids[0]!, seen: await seenOf(0), expectMode: mode, actor: ACTOR }, { policy })).toMatchObject({ ok: true });
    expect(await postReply(db.pool, ring, f.http, { replyId: ids[1]!, seen: await seenOf(1), expectMode: mode, actor: ACTOR }, { policy })).toMatchObject({ ok: true });
    const third = await postReply(db.pool, ring, f.http, { replyId: ids[2]!, seen: await seenOf(2), expectMode: mode, actor: ACTOR }, { policy });
    expect(third).toMatchObject({ ok: false, message: expect.stringMatching(/limit of 2 replies a day/) });
    expect(f.posts()).toHaveLength(2);
    expect((await reply(ids[2]!)).status).toBe("held");
    const view = await loadEngagement(db.pool);
    expect(view.used[0]).toMatchObject({ used: 2 });
  });

  it("makes the owner wait the gap between replies, and lets the next one through once it has passed", async () => {
    const { f, ids, seenOf } = await seed(["a", "b"]);
    await goLive();
    const policy = { repliesPerDay: 10, secondsBetweenReplies: 90 };
    expect(await postReply(db.pool, ring, f.http, { replyId: ids[0]!, seen: await seenOf(0), expectMode: mode, actor: ACTOR }, { policy })).toMatchObject({ ok: true });
    const early = await postReply(db.pool, ring, f.http, { replyId: ids[1]!, seen: await seenOf(1), expectMode: mode, actor: ACTOR }, { policy });
    expect(early).toMatchObject({ ok: false, message: expect.stringMatching(/Wait \d+ more seconds? before the next reply/) });
    expect(f.posts()).toHaveLength(1);
    await db.ownerPool.query("update comment_replies set attempted_at = now() - interval '100 seconds' where id = $1", [ids[0]]);
    expect(await postReply(db.pool, ring, f.http, { replyId: ids[1]!, seen: await seenOf(1), expectMode: mode, actor: ACTOR }, { policy })).toMatchObject({ ok: true });
    expect(f.posts()).toHaveLength(2);
  });

  it("two clicks at once on the same reply post it once", async () => {
    const { f, ids, seenOf } = await seed();
    await goLive();
    const seen = await seenOf(0);
    const results = await Promise.all([1, 2, 3].map(() => postReply(db.pool, ring, f.http, { replyId: ids[0]!, seen, expectMode: mode, actor: ACTOR }, { policy: NO_GAP })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(f.posts()).toHaveLength(1);
  });

  it("two clicks at once on two replies respect the gap: only one goes", async () => {
    const { f, ids, seenOf } = await seed(["a", "b"]);
    await goLive();
    const policy = { repliesPerDay: 10, secondsBetweenReplies: 90 };
    const seens = [await seenOf(0), await seenOf(1)];
    const results = await Promise.all([0, 1].map((i) => postReply(db.pool, ring, f.http, { replyId: ids[i]!, seen: seens[i]!, expectMode: mode, actor: ACTOR }, { policy })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(f.posts()).toHaveLength(1);
  });

  it("dry-run attempts are counted on their own, so rehearsing does not use up the live cap", async () => {
    const { f, ids, seenOf } = await seed(["a", "b"]);
    const policy = { repliesPerDay: 1, secondsBetweenReplies: 0 };
    expect(await postReply(db.pool, ring, f.http, { replyId: ids[0]!, seen: await seenOf(0), expectMode: mode, actor: ACTOR }, { policy })).toMatchObject({ ok: true, outcome: "dry_run" });
    expect(await postReply(db.pool, ring, f.http, { replyId: ids[1]!, seen: await seenOf(1), expectMode: mode, actor: ACTOR }, { policy })).toMatchObject({ ok: false });
    await goLive();
    expect(await postReply(db.pool, ring, f.http, { replyId: ids[1]!, seen: await seenOf(1), expectMode: mode, actor: ACTOR }, { policy })).toMatchObject({ ok: true, outcome: "posted" });
  });
});

describe("an unclear outcome is never retried", () => {
  for (const kind of ["throw", "500"] as const) {
    it(`${kind}: marked failed with 'check YouTube first'; pressing again posts nothing more`, async () => {
      const { f, ids, seenOf } = await seed();
      await goLive();
      f.insert = kind;
      const seen = await seenOf(0);
      const r = await postReply(db.pool, ring, f.http, { replyId: ids[0]!, seen, expectMode: mode, actor: ACTOR }, { policy: NO_GAP });
      expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/Check YouTube first/i) });
      expect(await reply(ids[0]!)).toMatchObject({ status: "failed", error: expect.stringMatching(/Check YouTube first/i) });
      expect((await db.ownerPool.query("select status from comments")).rows[0].status).toBe("failed");
      f.insert = "ok";
      expect(await postReply(db.pool, ring, f.http, { replyId: ids[0]!, seen, expectMode: mode, actor: ACTOR }, { policy: NO_GAP })).toMatchObject({ ok: false });
      expect(await editReply(db.pool, ids[0]!, "again", ACTOR)).toMatchObject({ ok: false }); // a failed reply cannot be edited back into the queue
      expect(f.posts()).toHaveLength(1); // the one attempt, no retry
      expect((await audits("comment.reply_failed")).length).toBe(1);
    });
  }

  it("a clear refusal (403) is failed too and is not retried", async () => {
    const { f, ids, seenOf } = await seed();
    await goLive();
    f.insert = "403";
    const seen = await seenOf(0);
    expect(await postReply(db.pool, ring, f.http, { replyId: ids[0]!, seen, expectMode: mode, actor: ACTOR }, { policy: NO_GAP })).toMatchObject({ ok: false, message: expect.stringMatching(/refused/) });
    expect((await reply(ids[0]!)).status).toBe("failed");
    await postReply(db.pool, ring, f.http, { replyId: ids[0]!, seen, expectMode: mode, actor: ACTOR }, { policy: NO_GAP });
    expect(f.posts()).toHaveLength(1);
  });
});

describe("stale tabs and the live switch", () => {
  it("refuses when the page was opened in another mode, including re-approving a dry-run row live", async () => {
    const { f, ids, seenOf } = await seed();
    const seen = await seenOf(0);
    expect(await postReply(db.pool, ring, f.http, { replyId: ids[0]!, seen, expectMode: "live", actor: ACTOR }, { policy: NO_GAP })).toMatchObject({ ok: false, message: expect.stringMatching(/Dry run changed/) });
    expect(await postReply(db.pool, ring, f.http, { replyId: ids[0]!, seen, expectMode: "dry", actor: ACTOR }, { policy: NO_GAP })).toMatchObject({ ok: true, outcome: "dry_run" });
    await goLive();
    expect(await postReply(db.pool, ring, f.http, { replyId: ids[0]!, seen, expectMode: "dry", actor: ACTOR }, { policy: NO_GAP })).toMatchObject({ ok: false, message: expect.stringMatching(/Dry run changed/) });
    expect(f.calls).toEqual([]);
    expect((await reply(ids[0]!)).status).toBe("dry_run");
  });

  it("turning dry run off needs the typed phrase in the data layer", async () => {
    await seed();
    expect(await saveUploadSwitches(db.pool, { commentsDryRun: false })).toMatchObject({ ok: false });
    expect(await saveUploadSwitches(db.pool, { commentsDryRun: false, typedLive: "post for real" })).toMatchObject({ ok: false });
    expect((await loadEngagement(db.pool)).dryRun).toBe(true);
    expect(await saveUploadSwitches(db.pool, { commentsDryRun: true })).toMatchObject({ ok: true });
  });
});

describe("a crash after approval", () => {
  it("any throw after approval marks the reply failed (unclear), never re-queued, and the owner can settle it by hand", async () => {
    const { f, ids, seenOf } = await seed();
    await goLive();
    await db.ownerPool.query("alter table quota_usage rename to quota_usage_x");
    let r;
    try {
      r = await postReply(db.pool, ring, f.http, { replyId: ids[0]!, seen: await seenOf(0), expectMode: mode, actor: ACTOR }, { policy: NO_GAP });
    } finally {
      await db.ownerPool.query("alter table quota_usage_x rename to quota_usage");
    }
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/Check YouTube first/i) });
    expect(await reply(ids[0]!)).toMatchObject({ status: "failed" });
    expect(f.posts()).toHaveLength(0);
    expect(await resolveReply(db.pool, ids[0]!, "posted", { kind: "token" } as never)).toEqual({ ok: false, message: ACTOR_REASON });
    expect(await resolveReply(db.pool, ids[0]!, "posted", ACTOR)).toEqual({ ok: true });
    expect(await reply(ids[0]!)).toMatchObject({ status: "posted" });
    expect((await db.ownerPool.query("select status from comments")).rows[0].status).toBe("posted");
    expect((await audits("comment.reply_resolved")).length).toBe(1);
  });

  it("a stuck 'approved' row can be settled only after 15 minutes on the database clock", async () => {
    const { ids } = await seed();
    await db.ownerPool.query("update comment_replies set status = 'approved', mode = 'live', attempted_at = now() where id = $1", [ids[0]]);
    expect(await resolveReply(db.pool, ids[0]!, "ignored", ACTOR)).toMatchObject({ ok: false });
    await db.ownerPool.query("update comment_replies set attempted_at = now() - interval '16 minutes' where id = $1", [ids[0]]);
    expect(await resolveReply(db.pool, ids[0]!, "ignored", ACTOR)).toEqual({ ok: true });
    expect((await reply(ids[0]!)).status).toBe("ignored");
  });
});

describe("edited replies and lock order", () => {
  it("an edit that trips the moderation rule makes the comment need your eyes", async () => {
    const { f, ids, seenOf } = await seed();
    expect(await editReply(db.pool, ids[0]!, "send money to my paypal", ACTOR)).toEqual({ ok: true });
    expect((await db.ownerPool.query("select needs_eyes, risk_reasons from comments")).rows[0].needs_eyes).toBe(true);
    expect(await postReply(db.pool, ring, f.http, { replyId: ids[0]!, seen: await seenOf(0), expectMode: mode, actor: ACTOR }, { policy: NO_GAP })).toMatchObject({ ok: false, message: expect.stringMatching(/needs your eyes/) });
  });

  it("ignore and post at the same time both finish (no deadlock) and nothing is posted twice", async () => {
    const { f, ids, seenOf } = await seed();
    await goLive();
    const cid = (await db.ownerPool.query("select id from comments")).rows[0].id;
    const seen = await seenOf(0);
    const [a, b] = await Promise.all([
      ignoreComment(db.pool, cid, ACTOR),
      postReply(db.pool, ring, f.http, { replyId: ids[0]!, seen, expectMode: mode, actor: ACTOR }, { policy: NO_GAP }),
    ]);
    expect(a.ok || b.ok).toBe(true);
    expect(f.posts().length).toBeLessThanOrEqual(1);
  });
});

describe("ignore", () => {
  it("an ignored comment's held reply cannot be posted", async () => {
    const { f, ids, seenOf } = await seed();
    await goLive();
    expect(await ignoreComment(db.pool, (await db.ownerPool.query("select id from comments")).rows[0].id, ACTOR)).toEqual({ ok: true });
    expect((await reply(ids[0]!)).status).toBe("ignored");
    expect(await postReply(db.pool, ring, f.http, { replyId: ids[0]!, seen: await seenOf(0), expectMode: mode, actor: ACTOR }, { policy: NO_GAP })).toMatchObject({ ok: false });
    expect(f.calls).toEqual([]);
  });
});
