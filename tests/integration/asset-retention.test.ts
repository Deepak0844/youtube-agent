import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { planRetention, runRetention, throttledRetention } from "@/server/db/retention";
import { addContent, createVideoRow } from "@/server/db/videos";
import { withTestDb, type TestDb } from "../support/db";

// Asset retention: dry run first, then the real run. Final video, Keep assets and assets another video uses stay. Nothing outside
// the storage root is touched. Audit rows carry counts only.

let db: TestDb;
let root: string;
const SHA = "a".repeat(64);
const BY = { kind: "session", sessionId: "11111111-1111-4111-8111-111111111111" } as const;

beforeAll(async () => {
  db = await withTestDb();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  root = mkdtempSync(path.join(tmpdir(), "retention-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const put = (rel: string, size: number) => {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, Buffer.alloc(size, 1));
  return abs;
};

async function asset(o: { keep?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  await db.ownerPool.query(
    `insert into assets (id, kind, original_name, mime, bytes, sha256, storage_ref, source, rights, keep)
     values ($1, 'image', 'p.png', 'image/png', 1000, $2, $3, 'stock', '{"attestations":["x"]}', $4)`,
    [id, randomUUID().replaceAll("-", "").repeat(2), `assets/${id}/p.png`, o.keep ?? false],
  );
  return id;
}

/** A video uploaded `daysAgo` days ago with a final file, a narration file and a scratch folder. */
async function uploaded(daysAgo: number) {
  const v = await createVideoRow(db.pool, { format: "short", kind: "scene_kit", language: "en", topic: `t-${daysAgo}`, channelId: "UCx" });
  await db.ownerPool.query(
    "insert into uploads (id, video_id, status, channel_id, youtube_id, started_at, finished_at, attempt) values (gen_random_uuid(), $1, 'uploaded', 'UCx', 'abc', now(), now() - make_interval(days => $2), 1)",
    [v.id, daysAgo],
  );
  const fin = `videos/${v.id}/final.mp4`;
  const nar = `videos/${v.id}/narration.wav`;
  const scratch = `videos/${v.id}/attempt-${randomUUID()}-1`;
  put(fin, 500);
  put(nar, 300);
  put(`${scratch}/tmp.bin`, 200);
  await addContent(db.pool, v.id, "video", { filePath: fin, sha256: SHA });
  await addContent(db.pool, v.id, "narration", { filePath: nar, sha256: SHA });
  return { id: v.id, fin: path.join(root, fin), nar: path.join(root, nar), scratch: path.join(root, scratch) };
}

const link = (videoId: string, assetId: string, beat = "hook") => db.ownerPool.query("insert into video_assets (video_id, asset_id, beat_id) values ($1, $2, $3)", [videoId, assetId, beat]);

describe("asset retention", () => {
  it("dry run lists files and bytes and changes nothing; a recent upload is not due", async () => {
    const old = await uploaded(10);
    await uploaded(0);
    const a = await asset();
    await link(old.id, a);
    const plan = await planRetention(db.pool, root);
    expect(plan.days).toBe(7);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ videoId: old.id, files: 2, bytes: 500, assets: 1, assetBytes: 1000 });
    expect([old.fin, old.nar, old.scratch].every((p) => existsSync(p))).toBe(true);
    expect((await db.ownerPool.query("select count(*)::int as n from audit_log where event like 'retention.%'")).rows[0].n).toBe(0);
  });

  it("removes working files, keeps the final video, Keep assets and shared assets, and audits counts only", async () => {
    const old = await uploaded(10);
    const other = await uploaded(0);
    const plain = await asset();
    const kept = await asset({ keep: true });
    const shared = await asset();
    await link(old.id, plain);
    await link(old.id, kept, "setup");
    await link(old.id, shared, "reveal");
    await link(other.id, shared);
    const r = await runRetention(db.pool, root, BY);
    expect(r).toMatchObject({ files: 2, bytes: 500, assets: 1 });
    expect(existsSync(old.fin)).toBe(true);
    expect(existsSync(old.nar)).toBe(false);
    expect(existsSync(old.scratch)).toBe(false);
    expect(existsSync(other.nar)).toBe(true); // not due
    const trashed = (await db.ownerPool.query("select id from assets where deleted_at is not null")).rows.map((x: { id: string }) => x.id);
    expect(trashed).toEqual([plain]);
    const audit = (await db.ownerPool.query("select detail from audit_log where event like 'retention.%'")).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].detail).toMatchObject({ videoId: old.id, by: "session", files: 2, bytes: 500, assetsTrashed: 1 });
    expect(JSON.stringify(audit)).not.toContain("videos/");
    expect((await runRetention(db.pool, root, BY)).items).toEqual([]); // nothing left to do
  });

  it("never touches a path that escapes the video folder or the storage root", async () => {
    const outside = path.join(tmpdir(), `outside-${randomUUID()}.txt`);
    writeFileSync(outside, "keep me");
    try {
      const old = await uploaded(10);
      await addContent(db.pool, old.id, "scenes", { filePath: `videos/${old.id}/../../${path.basename(outside)}`, sha256: SHA });
      await addContent(db.pool, old.id, "tsx", { filePath: `videos/${randomUUID()}/other-video.bin`, sha256: SHA });
      const other = put(`videos/${randomUUID()}/other-video.bin`, 10);
      const r = await runRetention(db.pool, root, BY);
      expect(r.files).toBe(2);
      expect(existsSync(outside)).toBe(true);
      expect(existsSync(other)).toBe(true);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it("skips a video that also has an upload that is not finished", async () => {
    const v = await uploaded(10);
    await db.ownerPool.query("insert into uploads (id, video_id, status, channel_id) values (gen_random_uuid(), $1, 'upload_failed', 'UCx')", [v.id]);
    expect((await planRetention(db.pool, root)).items).toEqual([]);
    expect(existsSync(v.nar)).toBe(true);
  });

  it("the worker hook runs at most once per interval on an injected clock", async () => {
    const v = await uploaded(10);
    let t = 0;
    const tick = throttledRetention(db.pool, root, { everyMs: 1000, now: () => t });
    await tick();
    expect(existsSync(v.nar)).toBe(false);
    put(`videos/${v.id}/attempt-${randomUUID()}-2/x.bin`, 5);
    t = 500;
    await tick();
    expect((await db.ownerPool.query("select count(*)::int as n from audit_log where event = 'retention.cleaned'")).rows[0].n).toBe(1);
    t = 1500;
    await tick();
    expect((await db.ownerPool.query("select count(*)::int as n from audit_log where event = 'retention.cleaned'")).rows[0].n).toBe(2);
  });
});
