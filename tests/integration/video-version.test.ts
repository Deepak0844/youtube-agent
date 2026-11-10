import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@/server/core/content-hash";
import { startVersion } from "@/server/db/video-create";
import { addContent, createVideoRow } from "@/server/db/videos";
import { ensureChannel } from "../support/channel-fixture";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
beforeAll(async () => {
  db = await withTestDb();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  queued.length = 0;
});

const SESSION = "0190f3a2-7c1e-7a55-9d3b-2f6c8a1b4e91";
const actor = { kind: "session", sessionId: SESSION } as const;
const queued: string[] = [];
const queue = { enqueue: async (id: string, fence: number, seq: number) => (queued.push(id), `stage.${id}.${fence}.${seq}`) };
const short = (o: Partial<{ kind: "scene_kit" | "tsx"; channelId: string | null; notes: string; style: string; language: "en" | "ta" }> = {}) =>
  createVideoRow(db.pool, { format: "short", kind: o.kind ?? "scene_kit", language: o.language ?? "ta", topic: "Why the sea is salty", notes: o.notes ?? "calm tone", channelId: o.channelId ?? null, style: o.style ?? "ai_studio", captionStyle: null });

describe("startVersion (remake a Short as another type)", () => {
  it("starts a NEW video on the same topic, notes, language and channel, audits it, and starts its route like any new video", async () => {
    await ensureChannel(db.pool, "UC1");
    const src = await short({ channelId: "UC1" });
    const r = await startVersion(db.pool, queue, actor, src.id, "tsx");
    if (!r.ok) throw new Error(r.message);
    expect(r.videoId).not.toBe(src.id);
    const v = (await db.pool.query("select topic, language, kind, format, notes, channel_id, style, derived_from from videos where id = $1", [r.videoId])).rows[0];
    expect(v).toEqual({ topic: "Why the sea is salty", language: "ta", kind: "tsx", format: "short", notes: "calm tone", channel_id: "UC1", style: "ai_studio", derived_from: null });
    expect((await db.pool.query("select status from stage_runs where video_id = $1", [r.videoId])).rows).toEqual([{ status: "queued" }]);
    expect(queued).toHaveLength(1);
    const a = (await db.pool.query("select detail from audit_log where event = 'video.version_made'")).rows;
    expect(a).toHaveLength(1);
    expect(a[0].detail).toMatchObject({ videoId: r.videoId, fromVideoId: src.id, kind: "tsx", sessionId: SESSION });
    expect(JSON.stringify(a[0].detail)).not.toContain("salty"); // the topic stays out of the audit row
  });
  it("shares nothing with the old video: no content, approvals or stage runs are copied, and the old video is untouched", async () => {
    const src = await short();
    await addContent(db.pool, src.id, "script", { body: { title: "T", narration: "n" }, sha256: sha256Hex("s") });
    await db.pool.query("insert into stage_runs (id, video_id, name, status, input_hash) values (gen_random_uuid(), $1, 'draft', 'succeeded', 'h')", [src.id]);
    const before = (await db.pool.query("select updated_at, status from videos where id = $1", [src.id])).rows[0];
    const r = await startVersion(db.pool, queue, actor, src.id, "scene3d");
    if (!r.ok) throw new Error(r.message);
    expect((await db.pool.query("select count(*)::int n from video_content where video_id = $1", [r.videoId])).rows[0].n).toBe(0);
    expect((await db.pool.query("select count(*)::int n from approvals where video_id = $1", [r.videoId])).rows[0].n).toBe(0);
    expect((await db.pool.query("select count(*)::int n from stage_runs where video_id = $1 and status = 'succeeded'", [r.videoId])).rows[0].n).toBe(0);
    expect((await db.pool.query("select updated_at, status from videos where id = $1", [src.id])).rows[0]).toEqual(before);
  });
  it("refuses a long video, the same type, a bad type, an unknown video, and a caller who is not the signed-in owner, creating nothing", async () => {
    const src = await short();
    const long = await createVideoRow(db.pool, { format: "long", kind: "scene_kit", language: "en", topic: "t", lengthMinMinutes: 3, lengthMaxMinutes: 8 });
    expect(await startVersion(db.pool, queue, actor, long.id, "tsx")).toMatchObject({ ok: false, message: expect.stringMatching(/Only a Short/) });
    expect(await startVersion(db.pool, queue, actor, src.id, "scene_kit")).toMatchObject({ ok: false, message: expect.stringMatching(/already is/) });
    expect(await startVersion(db.pool, queue, actor, src.id, "collage")).toMatchObject({ ok: false });
    for (const id of ["00000000-0000-4000-8000-000000000000", "not-a-uuid"]) expect(await startVersion(db.pool, queue, actor, id, "tsx"), id).toMatchObject({ ok: false, message: expect.stringMatching(/not found/) });
    for (const a of [undefined, null, {}, { kind: "token", sessionId: SESSION }, { kind: "session" }]) expect(await startVersion(db.pool, queue, a as never, src.id, "tsx")).toMatchObject({ ok: false });
    expect((await db.pool.query("select count(*)::int n from videos")).rows[0].n).toBe(2); // only the two seeded ones
    expect(queued).toHaveLength(0);
  });
});
