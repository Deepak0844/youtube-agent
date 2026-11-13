import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { approveGate } from "@/server/db/approvals";
import { loadThumbnailTab } from "@/server/db/thumbnail";
import { sendApprovedThumbnail } from "@/server/db/thumbnail-upload";
import { addContent, createVideoRow } from "@/server/db/videos";
import type { Uploader } from "@/server/providers/uploader";
import { ensureChannel } from "../support/channel-fixture";
import { withTestDb, type TestDb } from "../support/db";

// After a long video is uploaded, only its APPROVED, hash-checked thumbnail goes to YouTube, once. Fake YouTube only.

let db: TestDb;
let root: string;
const SESSION = { kind: "session", sessionId: "11111111-1111-4111-8111-111111111111" } as const;

beforeAll(async () => {
  db = await withTestDb();
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "thumb-up-")));
});
afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  await db.pool.query("insert into sessions (id, token_hash, expires_at, absolute_expires_at) values ($1, 'tu', clock_timestamp() + interval '1 day', clock_timestamp() + interval '7 days') on conflict (id) do nothing", [SESSION.sessionId]);
  await ensureChannel(db.pool, "UCthumb");
});

function setter(answer: { ok: true } | { ok: false; reason: string } = { ok: true }) {
  const calls: Array<{ yt: string; bytes: string }> = [];
  const u: Pick<Uploader, "setThumbnail"> = { setThumbnail: async (_row, yt, png) => { calls.push({ yt, bytes: png.toString() }); return answer; } };
  return { u, calls };
}

async function video(format: "long" | "short", o: { card?: string; approve?: boolean } = {}) {
  const v = format === "long"
    ? await createVideoRow(db.pool, { format: "long", kind: "collage", language: "en", topic: "Why the sea is salty", lengthMinMinutes: 3, lengthMaxMinutes: 8, channelId: "UCthumb" })
    : await createVideoRow(db.pool, { format: "short", kind: "collage", language: "en", topic: "Why the sea is salty", channelId: "UCthumb" });
  const rel = `videos/${v.id}/thumb-1.png`;
  if (o.card !== undefined) {
    mkdirSync(path.join(root, "videos", v.id), { recursive: true });
    writeFileSync(path.join(root, rel), o.card);
    await addContent(db.pool, v.id, "thumbnail", { filePath: rel, sha256: createHash("sha256").update(o.card).digest("hex") });
    if (o.approve !== false) expect(await approveGate(db.pool, { videoId: v.id, gate: "thumbnail", seenHash: (await loadThumbnailTab(db.pool, v.id)).seenHash!, actor: SESSION })).toMatchObject({ ok: true });
  }
  const up = (await db.ownerPool.query<{ id: string }>(
    "insert into uploads (id, video_id, status, channel_id, youtube_id, started_at, finished_at, attempt) values (gen_random_uuid(), $1, 'uploaded', 'UCthumb', 'ytABC123', now(), now(), 1) returning id",
    [v.id],
  )).rows[0]!.id;
  return { v, up, file: path.join(root, rel) };
}
const log = async (up: string) => (await db.pool.query<{ event: string }>("select event from upload_log where upload_id = $1 order by id", [up])).rows.map((r) => r.event);

describe("sendApprovedThumbnail", () => {
  it("sends the approved picture once and logs it; a second call sends nothing", async () => {
    const { up } = await video("long", { card: "png-bytes" });
    const s = setter();
    expect(await sendApprovedThumbnail(db.pool, s.u, up, { root })).toBe("set");
    expect(s.calls).toEqual([{ yt: "ytABC123", bytes: "png-bytes" }]);
    expect(await log(up)).toEqual(["thumbnail_claimed", "thumbnail_set"]);
    expect(await sendApprovedThumbnail(db.pool, s.u, up, { root })).toBe("skipped");
    expect(s.calls).toHaveLength(1);
  });

  it("never sends an unapproved card or a file swapped after approving", async () => {
    const a = await video("long", { card: "draft", approve: false });
    const s = setter();
    expect(await sendApprovedThumbnail(db.pool, s.u, a.up, { root })).toBe("failed");
    expect((await log(a.up))[1]).toMatch(/^thumbnail_failed: the thumbnail is not approved/);
    const b = await video("long", { card: "approved" });
    writeFileSync(b.file, "swapped!");
    expect(await sendApprovedThumbnail(db.pool, s.u, b.up, { root })).toBe("failed");
    expect((await log(b.up))[1]).toBe("thumbnail_failed: the thumbnail file changed after it was approved");
    expect(s.calls).toEqual([]);
  });

  it("a YouTube refusal is written once and not retried; shorts are skipped", async () => {
    const { up } = await video("long", { card: "png" });
    const s = setter({ ok: false, reason: "YouTube refused: custom thumbnails need a verified channel" });
    expect(await sendApprovedThumbnail(db.pool, s.u, up, { root })).toBe("failed");
    expect(await sendApprovedThumbnail(db.pool, s.u, up, { root })).toBe("skipped");
    expect(await log(up)).toEqual(["thumbnail_claimed", "thumbnail_failed: YouTube refused: custom thumbnails need a verified channel"]);
    const short = await video("short");
    expect(await sendApprovedThumbnail(db.pool, setter().u, short.up, { root })).toBe("skipped");
  });
});
