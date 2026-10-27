import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@/server/core/content-hash";
import { uuidv7 } from "@/server/core/ids";
import { UPLOAD_CAPS } from "@/server/core/publish-rules";
import { approveGate, liveGateHash } from "@/server/db/approvals";
import { createPool } from "@/server/db/pool";
import { approvePublish, requeueUpload } from "@/server/db/publish";
import { setSetting } from "@/server/db/settings";
import { markStalled } from "@/server/db/uploads";
import { addContent, createVideoRow } from "@/server/db/videos";
import { createJobQueue, type UploadQueue } from "@/server/queue/job-queue";
import { createFakeUploader } from "@/server/providers/uploader/fake";
import type { Uploader } from "@/server/providers/uploader";
import { startRuntime } from "@/worker/runtime";
import { handlePublishUpload } from "@/worker/stages/publish-upload";
import { withTestDb, type TestDb } from "../support/db";
import { waitFor } from "./helpers/stage-env";

let db: TestDb;
let root: string;
beforeAll(async () => {
  db = await withTestDb();
});
beforeEach(async () => {
  await db.reset();
  root = mkdtempSync(path.join(tmpdir(), "publish-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
afterAll(async () => {
  await db?.stop();
});

const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const FUTURE = () => new Date(Date.now() + 3 * 3600_000).toISOString();
const queue = () => ({ enqueueUpload: vi.fn(async (id: string) => `upload.${id}`) }) as unknown as UploadQueue & { enqueueUpload: ReturnType<typeof vi.fn> };

async function newSession(opts: { expiresInMs?: number; revoked?: boolean } = {}): Promise<string> {
  const id = uuidv7();
  await db.pool.query(
    `insert into sessions (id, token_hash, expires_at, absolute_expires_at, revoked_at)
     values ($1, $2, clock_timestamp() + ($3::bigint * interval '1 millisecond'), clock_timestamp() + interval '7 days', case when $4 then clock_timestamp() else null end)`,
    [id, `t-${id}`, String(opts.expiresInMs ?? 3600_000), opts.revoked ?? false],
  );
  return id;
}

interface Seed {
  videoId: string;
  sessionId: string;
  videoPath: string;
  videoBytes: Buffer;
}
async function seed(o: { visibility?: string; publishAt?: string | null; approveEvidence?: boolean; approveVideo?: boolean; channel?: string | null } = {}): Promise<Seed> {
  const v = await createVideoRow(db.pool, { format: "short", kind: "scene_kit", language: "en", topic: "t", channelId: o.channel === undefined ? "UC-test" : o.channel });
  const videoBytes = Buffer.from(`video-bytes-${v.id}`);
  const videoPath = `videos/${v.id}/final.mp4`;
  mkdirSync(path.join(root, "videos", v.id), { recursive: true });
  writeFileSync(path.join(root, videoPath), videoBytes);
  await addContent(db.pool, v.id, "video", { filePath: videoPath, sha256: sha(videoBytes) });
  await addContent(db.pool, v.id, "evidence", { filePath: "e/1.pdf", sha256: sha256Hex("evidence") });
  await addContent(db.pool, v.id, "metadata", { body: { title: "t", visibility: o.visibility ?? "private", publish_at: o.publishAt ?? null }, sha256: sha256Hex("meta") });
  const sessionId = await newSession();
  const actor = { kind: "session", sessionId } as const;
  if (o.approveVideo !== false) await approveGate(db.pool, { videoId: v.id, gate: "video", seenHash: (await liveGateHash(db.pool, v.id, "video"))!.hash, actor });
  if (o.approveEvidence !== false) await approveGate(db.pool, { videoId: v.id, gate: "evidence", seenHash: (await liveGateHash(db.pool, v.id, "evidence"))!.hash, actor });
  return { videoId: v.id, sessionId, videoPath, videoBytes };
}

async function approve(s: Seed, over: Partial<Parameters<typeof approvePublish>[2]> = {}, q = queue()) {
  const seenHash = (await liveGateHash(db.pool, s.videoId, "publish"))!.hash;
  const res = await approvePublish(
    db.pool,
    q,
    { videoId: s.videoId, seenHash, visibility: "private", publishAt: null, channelId: "UC-test", actor: { kind: "session", sessionId: s.sessionId }, ...over },
    { root },
  );
  return { res, q };
}
async function approved(o: Parameters<typeof seed>[0] = {}, over: Partial<Parameters<typeof approvePublish>[2]> = {}) {
  const s = await seed(o);
  const { res, q } = await approve(s, over);
  if (!res.ok) throw new Error(`fixture approval refused: ${res.reason}`);
  return { s, uploadId: res.uploadId, q };
}
const run = (uploadId: string, uploader: Uploader) => handlePublishUpload(db.pool, { uploader, root, caps: { ...UPLOAD_CAPS } }, uploadId);
const row = async (id: string) => (await db.pool.query("select * from uploads where id = $1", [id])).rows[0];
const count = async (t: string) => Number((await db.pool.query(`select count(*) c from ${t}`)).rows[0].c);
const auditOf = async (prefix: string) => (await db.pool.query("select event, detail from audit_log where event like $1 order by id", [`${prefix}%`])).rows;
const allowPublic = (on: boolean) => setSetting(db.pool, "policy.allow_public", on, { actor: "session" });

describe("approvePublish", () => {
  it("approves a private publish, writes the upload row bound to the hash and file sha, and enqueues once after commit", async () => {
    const s = await seed();
    const live = (await liveGateHash(db.pool, s.videoId, "publish"))!;
    const { res, q } = await approve(s);
    expect(res).toMatchObject({ ok: true, queued: true });
    const u = await row((res as { uploadId: string }).uploadId);
    expect(u).toMatchObject({ status: "publish_approved", approval_hash: live.hash, file_sha: sha(s.videoBytes), channel_id: "UC-test", video_id: s.videoId });
    expect(q.enqueueUpload).toHaveBeenCalledTimes(1);
    expect(q.enqueueUpload).toHaveBeenCalledWith(u.id);
  });

  it("public_visibility_is_refused_while_allow_public_is_off", async () => {
    const s = await seed({ visibility: "public" });
    const { res, q } = await approve(s, { visibility: "public" });
    expect(res).toMatchObject({ ok: false, reason: expect.stringMatching(/public/i) });
    expect(await count("uploads")).toBe(0);
    expect(await count("approvals where gate = 'publish'")).toBe(0);
    expect(q.enqueueUpload).not.toHaveBeenCalled();
    await allowPublic(true);
    expect((await approve(s, { visibility: "public" })).res.ok).toBe(true);
  });

  it("unlisted_does_not_need_the_kill_switch", async () => {
    const s = await seed({ visibility: "unlisted" });
    expect((await approve(s, { visibility: "unlisted" })).res.ok).toBe(true);
  });

  it("require_evidence_blocks_publish_until_evidence_is_signed_off", async () => {
    const s = await seed({ approveEvidence: false });
    const first = await approve(s);
    expect(first.res).toMatchObject({ ok: false, reason: expect.stringMatching(/evidence/i) });
    expect(await count("uploads")).toBe(0);
    await approveGate(db.pool, { videoId: s.videoId, gate: "evidence", seenHash: (await liveGateHash(db.pool, s.videoId, "evidence"))!.hash, actor: { kind: "session", sessionId: s.sessionId } });
    expect((await approve(s)).res.ok).toBe(true);
  });

  it("evidence_check_can_be_switched_off_only_by_the_policy_value_false", async () => {
    const s = await seed({ approveEvidence: false });
    await setSetting(db.pool, "policy.require_evidence", false, { actor: "session" });
    expect((await approve(s)).res.ok).toBe(true);
  });

  it("the_video_gate_must_be_approved_first", async () => {
    const s = await seed({ approveVideo: false });
    expect((await approve(s)).res).toMatchObject({ ok: false, reason: expect.stringMatching(/video/i) });
  });

  it("publish_at_less_than_60_minutes_ahead_is_refused", async () => {
    const soon = new Date(Date.now() + 30 * 60_000).toISOString();
    const s = await seed({ publishAt: soon });
    expect((await approve(s, { publishAt: soon })).res).toMatchObject({ ok: false, reason: expect.stringMatching(/60 minutes/) });
    const later = FUTURE();
    const s2 = await seed({ publishAt: later });
    expect((await approve(s2, { publishAt: later })).res.ok).toBe(true);
  });

  it("the_visibility_channel_and_time_the_owner_saw_must_match_what_is_stored", async () => {
    const s = await seed({ visibility: "private" });
    expect((await approve(s, { visibility: "unlisted" })).res.ok).toBe(false);
    expect((await approve(s, { channelId: "UC-other" })).res.ok).toBe(false);
    expect((await approve(s, { publishAt: FUTURE() })).res.ok).toBe(false);
    expect(await count("uploads")).toBe(0);
  });

  it("a_stale_hash_is_refused_and_nothing_is_written", async () => {
    const s = await seed();
    const { res } = await approve(s, { seenHash: "0".repeat(64) });
    expect(res.ok).toBe(false);
    expect(await count("uploads")).toBe(0);
  });

  it("human_gate_rule_nothing_approves_verifies_or_publishes_without_the_owner", async () => {
    const s = await seed();
    const real = s.sessionId;
    const expired = await newSession({ expiresInMs: -1000 });
    const revoked = await newSession({ revoked: true });
    const bad = [
      { kind: "token", sessionId: real },
      { kind: "job", sessionId: real },
      { kind: "system", sessionId: real },
      { kind: "session" },
      { kind: "session", sessionId: "not-a-uuid" },
      { kind: "session", sessionId: uuidv7() }, // well-formed but no such session
      { kind: "session", sessionId: expired },
      { kind: "session", sessionId: revoked },
      { kind: "session", sessionId: real, extra: 1 },
      null,
      undefined,
      "session",
    ];
    for (const actor of bad) {
      const { res, q } = await approve(s, { actor: actor as never });
      expect(res.ok, JSON.stringify(actor)).toBe(false);
      expect(q.enqueueUpload).not.toHaveBeenCalled();
    }
    expect(await count("uploads")).toBe(0);
    expect(await count("approvals where gate = 'publish'")).toBe(0);
    // the job runner has no path to start an upload that was never approved: no row, nothing to start
    const up = createFakeUploader();
    expect(await run(uuidv7(), up)).toEqual({ started: false });
    expect(up.totalCalls()).toBe(0);
  });

  it("the_file_bytes_must_match_the_stored_sha_at_approval", async () => {
    const s = await seed();
    writeFileSync(path.join(root, s.videoPath), "swapped after render");
    expect((await approve(s)).res).toMatchObject({ ok: false, reason: expect.stringMatching(/file/i) });
    expect(await count("uploads")).toBe(0);
  });

  it("a_missing_file_a_traversal_path_and_a_symlink_out_of_storage_are_refused", async () => {
    const s = await seed();
    rmSync(path.join(root, s.videoPath));
    expect((await approve(s)).res.ok).toBe(false);
    const outside = path.join(tmpdir(), `outside-${uuidv7()}`);
    writeFileSync(outside, s.videoBytes);
    try {
      symlinkSync(outside, path.join(root, s.videoPath));
      expect((await approve(s)).res.ok).toBe(false);
    } finally {
      rmSync(outside, { force: true });
    }
    const t = await createVideoRow(db.pool, { format: "short", kind: "scene_kit", language: "en", topic: "t", channelId: "UC-test" });
    await addContent(db.pool, t.id, "video", { filePath: "../../etc/passwd", sha256: sha256Hex("x") });
    await addContent(db.pool, t.id, "evidence", { filePath: "e/1.pdf", sha256: sha256Hex("e") });
    await addContent(db.pool, t.id, "metadata", { body: { visibility: "private", publish_at: null }, sha256: sha256Hex("m") });
    expect(await liveGateHash(db.pool, t.id, "publish")).not.toBeNull(); // the hash alone does not look at disk
    const r = await approvePublish(db.pool, queue(), { videoId: t.id, seenHash: (await liveGateHash(db.pool, t.id, "publish"))!.hash, visibility: "private", publishAt: null, channelId: "UC-test", actor: { kind: "session", sessionId: s.sessionId } }, { root });
    expect(r.ok).toBe(false);
  });

  it("a_second_approval_is_refused_while_an_upload_is_pending_or_has_run", async () => {
    const { s } = await approved();
    expect((await approve(s)).res).toMatchObject({ ok: false, reason: expect.stringMatching(/already/i) });
    expect(await count("uploads")).toBe(1);
  });

  it("audits_the_approval_id_the_hash_prefix_and_the_content_versions", async () => {
    const s = await seed();
    const { res } = await approve(s);
    if (!res.ok) throw new Error(res.reason);
    const [a] = await auditOf("publish.approved");
    const live = (await liveGateHash(db.pool, s.videoId, "publish"))!;
    expect(a.detail).toMatchObject({ videoId: s.videoId, approvalId: res.approvalId, uploadId: res.uploadId, hashPrefix: live.hash.slice(0, 12), visibility: "private", sessionId: s.sessionId });
    expect(a.detail.versions.video).toEqual({ id: live.versions.video!.id, version: 1 });
    expect(Object.keys(a.detail.versions).sort()).toEqual(["evidence", "metadata", "video"]);
  });

  it("an_enqueue_failure_after_commit_keeps_the_approval_and_can_be_requeued_by_id", async () => {
    const s = await seed();
    const q = queue();
    q.enqueueUpload.mockRejectedValueOnce(new Error("redis down"));
    const { res } = await approve(s, {}, q);
    expect(res).toMatchObject({ ok: true, queued: false });
    const id = (res as { uploadId: string }).uploadId;
    expect(await requeueUpload(db.pool, q, id)).toBe(true);
    expect(q.enqueueUpload).toHaveBeenCalledTimes(2);
    expect(await requeueUpload(db.pool, q, uuidv7())).toBe(false);
  });
});

describe("handlePublishUpload", () => {
  it("uploads_the_approved_file_once_with_the_fake_uploader_and_audits_what_was_bound", async () => {
    const { s, uploadId } = await approved();
    const up = createFakeUploader();
    expect(await run(uploadId, up)).toEqual({ started: true });
    const u = await row(uploadId);
    expect(u).toMatchObject({ status: "uploaded", youtube_id: `fake-${uploadId}` });
    expect(up.totalCalls()).toBe(1);
    const [a] = await auditOf("upload.started");
    const live = (await liveGateHash(db.pool, s.videoId, "publish"))!;
    expect(a.detail).toMatchObject({ uploadId, videoId: s.videoId, hashPrefix: live.hash.slice(0, 12), fileShaPrefix: sha(s.videoBytes).slice(0, 12) });
    expect(a.detail.approvalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.detail.versions.video.id).toBe(live.versions.video!.id);
  });

  it("changing_the_video_voids_the_publish_approval_and_blocks_a_queued_upload", async () => {
    const { s, uploadId } = await approved();
    const next = Buffer.from("a different cut");
    writeFileSync(path.join(root, "videos", s.videoId, "v2.mp4"), next);
    await addContent(db.pool, s.videoId, "video", { filePath: `videos/${s.videoId}/v2.mp4`, sha256: sha(next) });
    const up = createFakeUploader();
    expect(await run(uploadId, up)).toEqual({ started: false });
    expect(up.totalCalls()).toBe(0);
    expect((await row(uploadId)).status).toBe("publish_approved");
    expect((await auditOf("upload.refused"))[0].detail).toMatchObject({ uploadId, reason: "approval_changed" });
  });

  it("changing_the_metadata_or_the_channel_blocks_a_queued_upload", async () => {
    const a = await approved();
    await addContent(db.pool, a.s.videoId, "metadata", { body: { visibility: "public", publish_at: null }, sha256: sha256Hex("m2") });
    const up = createFakeUploader();
    expect(await run(a.uploadId, up)).toEqual({ started: false });
    const b = await approved();
    await db.ownerPool.query("update videos set channel_id = 'UC-other' where id = $1", [b.s.videoId]);
    expect(await run(b.uploadId, up)).toEqual({ started: false });
    expect(up.totalCalls()).toBe(0);
  });

  it("file_bytes_swapped_after_approval_block_the_upload_even_though_the_database_still_matches", async () => {
    const { s, uploadId } = await approved();
    writeFileSync(path.join(root, s.videoPath), "tampered on disk");
    const up = createFakeUploader();
    expect(await run(uploadId, up)).toEqual({ started: false });
    expect(up.totalCalls()).toBe(0);
    expect((await auditOf("upload.refused"))[0].detail).toMatchObject({ reason: "file_changed" });
  });

  it("a_missing_file_blocks_the_upload", async () => {
    const { s, uploadId } = await approved();
    rmSync(path.join(root, s.videoPath));
    const up = createFakeUploader();
    expect(await run(uploadId, up)).toEqual({ started: false });
    expect(up.totalCalls()).toBe(0);
  });

  it("the_upload_row_cannot_be_pointed_at_a_different_file_than_the_approved_one", async () => {
    const { uploadId } = await approved();
    await db.ownerPool.query("update uploads set file_sha = $2 where id = $1", [uploadId, sha("something else")]);
    const up = createFakeUploader();
    expect(await run(uploadId, up)).toEqual({ started: false });
    expect(up.totalCalls()).toBe(0);
  });

  it("an_approval_from_a_session_that_never_existed_is_refused_at_job_time", async () => {
    const { uploadId, s } = await approved();
    await db.ownerPool.query("update approvals set session_id = $2 where video_id = $1 and gate = 'publish'", [s.videoId, uuidv7()]);
    const up = createFakeUploader();
    expect(await run(uploadId, up)).toEqual({ started: false });
    expect(up.totalCalls()).toBe(0);
    expect((await auditOf("upload.refused"))[0].detail).toMatchObject({ reason: "approval_session_invalid" });
  });

  it("an_approval_made_in_a_session_that_was_already_revoked_is_refused_at_job_time", async () => {
    const { uploadId, s } = await approved();
    await db.ownerPool.query("update sessions set revoked_at = (select decided_at from approvals where video_id = $1 and gate = 'publish') - interval '1 second' where id = $2", [s.videoId, s.sessionId]);
    const up = createFakeUploader();
    expect(await run(uploadId, up)).toEqual({ started: false });
    expect(up.totalCalls()).toBe(0);
  });

  it("logging_out_after_approving_does_not_cancel_the_upload", async () => {
    const { uploadId, s } = await approved();
    await db.ownerPool.query("update sessions set revoked_at = clock_timestamp() where id = $1", [s.sessionId]);
    expect(await run(uploadId, createFakeUploader())).toEqual({ started: true });
  });

  it("the_kill_switch_is_checked_again_at_job_time", async () => {
    await allowPublic(true);
    const { uploadId } = await approved({ visibility: "public" }, { visibility: "public" });
    await allowPublic(false);
    const up = createFakeUploader();
    expect(await run(uploadId, up)).toEqual({ started: false });
    expect(up.totalCalls()).toBe(0);
    expect((await auditOf("upload.refused"))[0].detail).toMatchObject({ reason: "policy" });
  });

  it("a_scheduled_time_that_has_already_passed_is_refused_at_job_time", async () => {
    const soon = new Date(Date.now() + 61 * 60_000).toISOString();
    const { uploadId } = await approved({ publishAt: soon }, { publishAt: soon });
    await db.ownerPool.query("update video_content set body = jsonb_set(body, '{publish_at}', to_jsonb($1::text)) where kind = 'metadata'", [new Date(Date.now() - 1000).toISOString()]);
    const up = createFakeUploader();
    expect(await run(uploadId, up)).toEqual({ started: false });
    expect(up.totalCalls()).toBe(0);
  });

  it("duplicate_upload_delivery_does_nothing", async () => {
    const { uploadId } = await approved();
    const up = createFakeUploader();
    expect(await run(uploadId, up)).toEqual({ started: true });
    expect(await run(uploadId, up)).toEqual({ started: false });
    expect(up.totalCalls()).toBe(1);
    expect((await row(uploadId)).status).toBe("uploaded");
  });

  it("second_publish_approved_to_uploading_transition_is_impossible", async () => {
    const { uploadId } = await approved();
    const up = createFakeUploader();
    const results = await Promise.all(Array.from({ length: 6 }, () => run(uploadId, up)));
    expect(results.filter((r) => r.started)).toHaveLength(1);
    expect(up.totalCalls()).toBe(1);
    expect(await count("upload_log where event = 'started'")).toBe(1);
  });

  it("failed_upload_is_never_retried_automatically", async () => {
    const { uploadId } = await approved();
    const failing: Uploader = { upload: vi.fn(async () => ({ kind: "failed" as const, reason: "rejected by youtube" })) };
    expect(await run(uploadId, failing)).toEqual({ started: true });
    expect((await row(uploadId)).status).toBe("upload_failed");
    expect(await run(uploadId, failing)).toEqual({ started: false });
    expect(await requeueUpload(db.pool, queue(), uploadId)).toBe(false); // only publish_approved rows are requeued
    expect(failing.upload).toHaveBeenCalledTimes(1);
  });

  it("an_uploader_that_throws_after_bytes_leaves_a_studio_first_failure_and_is_not_rerun", async () => {
    const { uploadId } = await approved();
    const boom: Uploader = { upload: vi.fn(async (_id, onProgress) => { await onProgress(10); throw new Error("socket reset"); }) };
    await run(uploadId, boom);
    expect((await row(uploadId)).failure_reason).toMatch(/check YouTube Studio first/);
    await run(uploadId, boom);
    expect(boom.upload).toHaveBeenCalledTimes(1);
  });

  it("late_success_is_recorded", async () => {
    const { uploadId } = await approved();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: Uploader = { upload: async (id, onProgress) => { await onProgress(5); await gate; return { kind: "uploaded", youtubeId: `late-${id}` }; } };
    const pending = run(uploadId, slow);
    await waitFor(async () => (await row(uploadId))?.status === "uploading", "uploading");
    await db.ownerPool.query("update uploads set last_progress_at = clock_timestamp() - interval '10 minutes' where id = $1", [uploadId]);
    expect(await markStalled(db.pool, 1000)).toEqual([uploadId]);
    release();
    await pending;
    expect(await row(uploadId)).toMatchObject({ status: "uploaded", youtube_id: `late-${uploadId}` });
    expect(await count("upload_log where event like 'late_success%'")).toBe(1);
  });

  it("the_job_payload_cannot_choose_the_file_or_the_hash_only_the_upload_id_is_read", async () => {
    const { uploadId } = await approved();
    const up = createFakeUploader();
    // extra arguments are ignored: the handler's signature takes the id only
    await (handlePublishUpload as unknown as (...a: unknown[]) => Promise<unknown>)(db.pool, { uploader: up, root, caps: UPLOAD_CAPS }, uploadId, { fileSha: "x", approvalHash: "y", path: "/etc/passwd" });
    expect((await row(uploadId)).status).toBe("uploaded");
  });
});

describe("worker runtime uploads consumer", () => {
  it("consumes_the_uploads_queue_with_the_supplied_uploader_and_finishes_the_upload", async () => {
    const suffix = `pub-${process.pid}`;
    const uq = createJobQueue(db.redisUrl, "uploads", suffix);
    const sq = createJobQueue(db.redisUrl, "stages", suffix);
    const up = createFakeUploader();
    const worker = startRuntime({
      pool: createPool(db.pool.options.connectionString!),
      redisUrl: db.redisUrl,
      log: vi.fn(),
      uploader: up,
      storageRoot: root,
      hooks: { connectQueue: async () => sq, connectUploadQueue: async () => uq },
    });
    try {
      await worker.ready;
      const s = await seed();
      const { res } = await approve(s, {}, uq as never);
      if (!res.ok) throw new Error(res.reason);
      await waitFor(async () => (await row(res.uploadId))?.status === "uploaded", "upload finished via the worker");
      expect(up.totalCalls()).toBe(1);
    } finally {
      await worker.stop();
      await uq.close();
      await sq.close();
    }
  });
});
