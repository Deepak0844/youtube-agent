import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "@/server/core/ids";
import { makeKeyring } from "@/server/core/vault-crypto";
import { getMediaKey, getOrCreateMediaKey, MediaKeyError, MEDIA_KEY_SECRET } from "@/server/db/media-key";
import { claimStage, commitStage, insertQueuedStage, type Claim } from "@/server/db/stages";
import { promoteAttempt, sweepLostAttempts } from "@/server/storage/store";
import { attemptDir, videoPath } from "@/server/storage/paths";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
let root: string;
beforeAll(async () => {
  db = await withTestDb();
});
beforeEach(async () => {
  await db.reset();
  root = mkdtempSync(path.join(tmpdir(), "ytstudio-promote-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
afterAll(async () => {
  await db?.stop();
});

async function claimed(videoId = uuidv7(), name = "render"): Promise<{ claim: Claim; videoId: string; stageId: string }> {
  const stageId = await insertQueuedStage(db.pool, { videoId, name, inputHash: "h" });
  const claim = await claimStage(db.pool, { id: stageId, inputHash: "h", workerId: "w1", ttlMs: 60_000 });
  if (!claim) throw new Error("claim failed");
  return { claim, videoId, stageId };
}
function put(dir: string, name: string, body = name): void {
  mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  writeFileSync(path.join(dir, name), body);
}
// Same stage run lost its lease and was claimed again: what the reconciler + a second worker do (fence goes up).
async function reclaim(stageId: string, workerId = "w1"): Promise<Claim> {
  await db.pool.query("update stage_runs set status='queued', lease_owner=null, lease_until=null, attempt_seq=attempt_seq+1 where id=$1", [stageId]);
  const c = await claimStage(db.pool, { id: stageId, inputHash: "h", workerId, ttlMs: 60_000 });
  if (!c) throw new Error("reclaim failed");
  return c;
}

describe("promoteAttempt", () => {
  it("promote_is_atomic_and_idempotent", async () => {
    const { claim, videoId } = await claimed();
    const dir = attemptDir(root, videoId, "render", claim.fence);
    put(dir, "final.mp4", "VIDEO");
    put(dir, "thumb.png", "PNG");
    expect(await promoteAttempt(db.pool, claim, ["final.mp4", "thumb.png"], { root })).toBe(true);
    expect(readFileSync(videoPath(root, videoId, "final.mp4"), "utf8")).toBe("VIDEO");
    expect(readFileSync(videoPath(root, videoId, "thumb.png"), "utf8")).toBe("PNG");
    expect(existsSync(path.join(dir, "final.mp4"))).toBe(false);
    // second call (a retry after a crash between promote and the next step) changes nothing and still succeeds
    expect(await promoteAttempt(db.pool, claim, ["final.mp4", "thumb.png"], { root })).toBe(true);
    expect(readFileSync(videoPath(root, videoId, "final.mp4"), "utf8")).toBe("VIDEO");
  });

  it("a_missing_file_fails_the_whole_promotion_and_moves_nothing", async () => {
    const { claim, videoId } = await claimed();
    const dir = attemptDir(root, videoId, "render", claim.fence);
    put(dir, "a.mp4", "A");
    await expect(promoteAttempt(db.pool, claim, ["a.mp4", "missing.png"], { root })).rejects.toThrow();
    expect(existsSync(path.join(dir, "a.mp4"))).toBe(true);
    expect(existsSync(videoPath(root, videoId, "a.mp4"))).toBe(false);
  });

  it("stale_attempt_dir_is_never_promoted", async () => {
    const { claim: old, videoId, stageId } = await claimed();
    const oldDir = attemptDir(root, videoId, "render", old.fence);
    put(oldDir, "final.mp4", "STALE");
    const fresh = await reclaim(stageId);
    expect(fresh.fence).toBeGreaterThan(old.fence);
    // the old worker wakes up late and tries to promote
    expect(await promoteAttempt(db.pool, old, ["final.mp4"], { root })).toBe(false);
    expect(existsSync(videoPath(root, videoId, "final.mp4"))).toBe(false);
    expect(readFileSync(path.join(oldDir, "final.mp4"), "utf8")).toBe("STALE"); // untouched; the sweep removes it later
    // the new worker promotes its own files
    put(attemptDir(root, videoId, "render", fresh.fence), "final.mp4", "FRESH");
    expect(await promoteAttempt(db.pool, fresh, ["final.mp4"], { root })).toBe(true);
    expect(readFileSync(videoPath(root, videoId, "final.mp4"), "utf8")).toBe("FRESH");
  });

  it("a_stage_that_is_no_longer_running_or_belongs_to_another_worker_is_not_promoted", async () => {
    const a = await claimed();
    put(attemptDir(root, a.videoId, "render", a.claim.fence), "x.mp4");
    expect(await promoteAttempt(db.pool, { ...a.claim, workerId: "someone-else" }, ["x.mp4"], { root })).toBe(false);
    expect(await commitStage(db.pool, a.claim, {})).toBe(true);
    expect(await promoteAttempt(db.pool, a.claim, ["x.mp4"], { root })).toBe(false);
    expect(existsSync(videoPath(root, a.videoId, "x.mp4"))).toBe(false);
    // unknown stage run
    expect(await promoteAttempt(db.pool, { ...a.claim, stageRunId: uuidv7() }, ["x.mp4"], { root })).toBe(false);
  });

  it("hostile_file_names_and_symlinks_are_refused_and_nothing_moves", async () => {
    const { claim, videoId } = await claimed();
    const dir = attemptDir(root, videoId, "render", claim.fence);
    put(dir, "good.mp4");
    const secret = path.join(root, "secret.txt");
    writeFileSync(secret, "S");
    symlinkSync(secret, path.join(dir, "link.mp4"));
    for (const bad of ["../x", "/etc/passwd", "a\0b", "..", "", "sub/../../x", "link.mp4"]) {
      await expect(promoteAttempt(db.pool, claim, ["good.mp4", bad], { root }), JSON.stringify(bad)).rejects.toThrow();
    }
    await expect(promoteAttempt(db.pool, claim, [], { root })).rejects.toThrow();
    expect(existsSync(path.join(dir, "good.mp4"))).toBe(true);
    expect(existsSync(videoPath(root, videoId, "good.mp4"))).toBe(false);
    expect(readFileSync(secret, "utf8")).toBe("S");
  });

  it("a_symlinked_video_folder_cannot_redirect_promoted_files_outside_the_root", async () => {
    const { claim, videoId } = await claimed();
    const dir = attemptDir(root, videoId, "render", claim.fence);
    put(dir, "final.mp4", "X");
    const outside = mkdtempSync(path.join(tmpdir(), "ytstudio-outside-"));
    try {
      mkdirSync(path.join(root, "videos", videoId), { recursive: true });
      symlinkSync(outside, path.join(root, "videos", videoId, "nested"));
      put(dir, "nested/deep.mp4", "Y");
      await expect(promoteAttempt(db.pool, claim, ["final.mp4", "nested/deep.mp4"], { root })).rejects.toThrow();
      expect(readdirSync(outside)).toEqual([]);
      expect(existsSync(path.join(dir, "final.mp4"))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("nested_names_are_promoted_with_their_folders", async () => {
    const { claim, videoId } = await claimed();
    const dir = attemptDir(root, videoId, "render", claim.fence);
    put(dir, "frames/001.png", "F1");
    expect(await promoteAttempt(db.pool, claim, ["frames/001.png"], { root })).toBe(true);
    expect(readFileSync(videoPath(root, videoId, "frames", "001.png"), "utf8")).toBe("F1");
  });
});

describe("sweepLostAttempts", () => {
  it("removes_attempt_dirs_of_lost_fences_and_keeps_the_current_and_unknown_ones", async () => {
    const { claim: old, videoId, stageId } = await claimed();
    const oldDir = attemptDir(root, videoId, "render", old.fence);
    put(oldDir, "partial.mp4");
    const fresh = await reclaim(stageId);
    const freshDir = attemptDir(root, videoId, "render", fresh.fence);
    put(freshDir, "wip.mp4");
    const unknownVideo = uuidv7();
    const unknownDir = attemptDir(root, unknownVideo, "render", 1);
    put(unknownDir, "keep.mp4");
    put(videoPath(root, videoId), "final.mp4", "PROMOTED"); // promoted files are never touched
    const removed = await sweepLostAttempts(db.pool, { root });
    expect(removed).toBe(1);
    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(freshDir)).toBe(true);
    expect(existsSync(unknownDir)).toBe(true);
    expect(readFileSync(videoPath(root, videoId, "final.mp4"), "utf8")).toBe("PROMOTED");
  });

  it("ignores_odd_names_and_never_follows_a_symlinked_attempt_dir", async () => {
    const videoId = uuidv7();
    const outside = mkdtempSync(path.join(tmpdir(), "ytstudio-outside-"));
    try {
      writeFileSync(path.join(outside, "precious.txt"), "P");
      mkdirSync(path.join(root, "videos", videoId), { recursive: true });
      symlinkSync(outside, path.join(root, "videos", videoId, "attempt-render-1"));
      mkdirSync(path.join(root, "videos", videoId, "attempt-weird"));
      mkdirSync(path.join(root, "videos", "not-a-uuid", "attempt-render-1"), { recursive: true });
      await insertQueuedStage(db.pool, { videoId, name: "render", inputHash: "h" });
      await db.pool.query("update stage_runs set fence = 5 where video_id = $1", [videoId]);
      expect(await sweepLostAttempts(db.pool, { root })).toBe(0);
      expect(readFileSync(path.join(outside, "precious.txt"), "utf8")).toBe("P");
      expect(existsSync(path.join(root, "videos", videoId, "attempt-weird"))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("a_missing_videos_folder_is_fine", async () => {
    expect(await sweepLostAttempts(db.pool, { root })).toBe(0);
  });
});

describe("media signing key", () => {
  const ring = () => makeKeyring(randomBytes(32).toString("base64"));

  it("is_created_once_is_32_bytes_and_is_stable_across_calls_and_races", async () => {
    const r = ring();
    expect(await getMediaKey(db.pool, r)).toBeNull(); // read-only path never creates
    const keys = await Promise.all(Array.from({ length: 6 }, () => getOrCreateMediaKey(db.pool, r)));
    for (const k of keys) {
      expect(k.length).toBe(32);
      expect(k.equals(keys[0]!)).toBe(true);
    }
    expect((await getMediaKey(db.pool, r))!.equals(keys[0]!)).toBe(true);
    const n = await db.pool.query("select count(*)::int as n from secrets where name = $1", [MEDIA_KEY_SECRET]);
    expect(n.rows[0].n).toBe(1);
  });

  it("is_stored_encrypted_without_a_hint", async () => {
    const r = ring();
    const key = await getOrCreateMediaKey(db.pool, r);
    const row = (await db.ownerPool.query("select ciphertext, hint from secrets where name = $1", [MEDIA_KEY_SECRET])).rows[0];
    expect(row.hint).toBe("");
    expect((row.ciphertext as Buffer).includes(key)).toBe(false);
    expect((row.ciphertext as Buffer).toString("latin1")).not.toContain(key.toString("base64"));
  });

  it("wrong_vault_key_gives_an_explicit_error_not_unsigned_urls", async () => {
    const good = ring();
    const key = await getOrCreateMediaKey(db.pool, good);
    const before = (await db.ownerPool.query("select ciphertext, nonce, key_id from secrets where name = $1", [MEDIA_KEY_SECRET])).rows[0];
    const wrong = ring();
    await expect(getOrCreateMediaKey(db.pool, wrong)).rejects.toMatchObject({ name: "MediaKeyError", code: "vault_unreadable" });
    await expect(getMediaKey(db.pool, wrong)).rejects.toBeInstanceOf(MediaKeyError);
    // a wrong key must NOT silently replace the stored key (that would invalidate every URL and hide the problem)
    const after = (await db.ownerPool.query("select ciphertext, nonce, key_id from secrets where name = $1", [MEDIA_KEY_SECRET])).rows[0];
    expect(Buffer.compare(after.ciphertext, before.ciphertext)).toBe(0);
    expect((await getOrCreateMediaKey(db.pool, good)).equals(key)).toBe(true);
  });

  it("a_stored_value_of_the_wrong_shape_is_an_error_not_a_weak_key", async () => {
    const r = ring();
    const { putSecret } = await import("@/server/db/vault");
    await putSecret(db.pool, r, MEDIA_KEY_SECRET, "short", { hint: false });
    await expect(getOrCreateMediaKey(db.pool, r)).rejects.toMatchObject({ code: "key_corrupt" });
  });

  it("creating_the_key_writes_no_audit_row_and_error_text_has_no_key", async () => {
    const r = ring();
    const key = await getOrCreateMediaKey(db.pool, r);
    const audit = await db.ownerPool.query("select * from audit_log");
    expect(JSON.stringify(audit.rows)).not.toContain(key.toString("base64"));
    try {
      await getOrCreateMediaKey(db.pool, ring());
    } catch (e) {
      expect(String(e) + JSON.stringify(e)).not.toContain(key.toString("base64"));
    }
  });
});
