import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@/server/core/content-hash";
import { uuidv7 } from "@/server/core/ids";
import { approvalState, approveGate, liveGateHash } from "@/server/db/approvals";
import { approvePublish } from "@/server/db/publish";
import { autoSeoSweep } from "@/server/db/seo";
import { loadUploadDetails, saveUploadDetails } from "@/server/db/upload-details";
import { addContent, createVideoRow, latestContent } from "@/server/db/videos";
import { addVerifiedEvidence } from "../support/publishable";
import { ensureChannel } from "../support/channel-fixture";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
beforeAll(async () => {
  db = await withTestDb();
});
beforeEach(async () => {
  await db.reset();
});
afterAll(async () => {
  await db?.stop();
});

const GOOD = { title: "Why the sky is blue", description: "Light scatters.", tags: ["sky"], category_id: 27, language: "en", made_for_kids: false, synthetic_content: false };

async function session(): Promise<{ kind: "session"; sessionId: string }> {
  const id = uuidv7();
  await db.pool.query(
    "insert into sessions (id, token_hash, expires_at, absolute_expires_at) values ($1, $2, clock_timestamp() + interval '1 hour', clock_timestamp() + interval '7 days')",
    [id, `t-${id}`],
  );
  return { kind: "session", sessionId: id };
}
async function video(channel: string | null = null) {
  const v = await createVideoRow(db.pool, { format: "short", kind: "scene_kit", language: "en", topic: "sky", channelId: channel });
  await addContent(db.pool, v.id, "video", { filePath: `v/${v.id}.mp4`, sha256: sha256Hex(`video-${v.id}`) });
  await addContent(db.pool, v.id, "evidence", { filePath: "e/1.pdf", sha256: sha256Hex("evidence") });
  await addContent(db.pool, v.id, "metadata", { body: { title: "t", visibility: "private", publish_at: null }, sha256: sha256Hex("meta") });
  return v;
}
const auditOf = async (prefix: string) => (await db.pool.query("select event, detail from audit_log where event like $1 order by id", [`${prefix}%`])).rows;

describe("upload details", () => {
  it("saves a new metadata version and keeps visibility and publish_at", async () => {
    const v = await video();
    const r = await saveUploadDetails(db.pool, v.id, GOOD, await session());
    expect(r).toEqual({ ok: true });
    const body = (await latestContent(db.pool, v.id, "metadata"))!.body as Record<string, unknown>;
    expect(body).toMatchObject({ ...GOOD, visibility: "private", publish_at: null });
    expect((await auditOf("upload_details.saved")).length).toBe(1);
  });

  it("refuses bad input on the server and writes nothing", async () => {
    const v = await video();
    const s = await session();
    const before = (await latestContent(db.pool, v.id, "metadata"))!.version;
    for (const bad of [{ ...GOOD, title: "x".repeat(101) }, { ...GOOD, title: "a<b" }, { ...GOOD, made_for_kids: undefined }, { ...GOOD, tags: ["a".repeat(501)] }]) {
      expect((await saveUploadDetails(db.pool, v.id, bad, s)).ok).toBe(false);
    }
    expect((await latestContent(db.pool, v.id, "metadata"))!.version).toBe(before);
  });

  it("refuses a caller that is not an owner session", async () => {
    const v = await video();
    const r = await saveUploadDetails(db.pool, v.id, GOOD, { kind: "token", sessionId: "x" } as never);
    expect(r.ok).toBe(false);
    expect((await latestContent(db.pool, v.id, "metadata"))!.version).toBe(1);
  });

  it("changing the details after a publish approval voids that approval", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "details-"));
    try {
      await ensureChannel(db.pool, "UC-test");
      const v = await createVideoRow(db.pool, { format: "short", kind: "scene_kit", language: "en", topic: "sky", channelId: "UC-test" });
      const bytes = Buffer.from(`video-${v.id}`);
      mkdirSync(path.join(root, "videos", v.id), { recursive: true });
      writeFileSync(path.join(root, "videos", v.id, "final.mp4"), bytes);
      await addContent(db.pool, v.id, "video", { filePath: `videos/${v.id}/final.mp4`, sha256: sha256Hex(bytes) });
      await addVerifiedEvidence(db.pool, v.id); // the publish approval needs claim-based, verified evidence
      const s = await session();
      expect(await saveUploadDetails(db.pool, v.id, GOOD, s)).toEqual({ ok: true });
      for (const gate of ["video", "evidence"] as const) await approveGate(db.pool, { videoId: v.id, gate, seenHash: (await liveGateHash(db.pool, v.id, gate))!.hash, actor: s });
      const q = { enqueueUpload: async () => "j" } as never;
      const seenHash = (await liveGateHash(db.pool, v.id, "publish"))!.hash;
      const res = await approvePublish(db.pool, q, { videoId: v.id, seenHash, visibility: "private", publishAt: null, channelId: "UC-test", actor: s }, { root });
      expect(res.ok).toBe(true);
      expect((await approvalState(db.pool, v.id, "publish")).approved).toBe(true);
      await saveUploadDetails(db.pool, v.id, { ...GOOD, made_for_kids: true }, s);
      expect((await approvalState(db.pool, v.id, "publish")).approved).toBe(false);
      // and the old hash can no longer be approved
      const again = await approvePublish(db.pool, q, { videoId: v.id, seenHash, visibility: "private", publishAt: null, channelId: "UC-test", actor: s }, { root });
      expect(again.ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("starts from the channel's choices and defaults to not for kids", async () => {
    await ensureChannel(db.pool, "UC-kids");
    await db.pool.query("update youtube_channels set made_for_kids = true, category_id = 24, default_language = 'hi' where channel_id = 'UC-kids'");
    const withChannel = await loadUploadDetails(db.pool, (await video("UC-kids")).id);
    expect(withChannel!.draft).toMatchObject({ made_for_kids: true, category_id: 24, language: "hi" });
    const none = await loadUploadDetails(db.pool, (await video()).id);
    expect(none!.draft).toMatchObject({ made_for_kids: false, category_id: 27, language: "en" });
  });
});

describe("first metadata draft after render", () => {
  async function rendered(notes?: string) {
    const v = await createVideoRow(db.pool, { format: "short", kind: "scene_kit", language: "en", topic: "sky", notes });
    await addContent(db.pool, v.id, "script", { body: { narration: "n", title: "T", beats: [], evidence: [] }, sha256: sha256Hex(`script-${v.id}`) });
    await addContent(db.pool, v.id, "beats", { body: { beats: [] }, sha256: sha256Hex(`beats-${v.id}`) });
    const s = await session();
    await approveGate(db.pool, { videoId: v.id, gate: "script", seenHash: (await liveGateHash(db.pool, v.id, "script"))!.hash, actor: s });
    await db.pool.query("insert into stage_runs (id, video_id, name, status, input_hash) values ($1, $2, 'qa', 'succeeded', $3)", [uuidv7(), v.id, sha256Hex(`qa-${v.id}`)]);
    return v;
  }
  const seoRuns = async (id: string) => Number((await db.pool.query("select count(*) c from stage_runs where video_id = $1 and name = 'seo'", [id])).rows[0].c);

  it("queues exactly one seo run, once, and never again after it", async () => {
    const v = await rendered();
    const enqueued: string[] = [];
    const q = { enqueue: async (id: string) => (enqueued.push(id), "j") } as never;
    expect((await autoSeoSweep(db.pool, q)).length).toBe(1);
    expect((await autoSeoSweep(db.pool, q)).length).toBe(0);
    expect(await seoRuns(v.id)).toBe(1);
    await db.pool.query("update stage_runs set status = 'failed' where video_id = $1 and name = 'seo'", [v.id]);
    expect((await autoSeoSweep(db.pool, q)).length).toBe(0);
    expect(enqueued.length).toBe(1);
    expect((await auditOf("seo.auto_requested")).filter((r) => r.detail.videoId === v.id).length).toBe(1);
  });

  it("leaves videos that have not finished rendering, and dry-run videos, alone", async () => {
    const early = await createVideoRow(db.pool, { format: "short", kind: "scene_kit", language: "en", topic: "x" });
    const dry = await rendered("dry run");
    const q = { enqueue: async () => "j" } as never;
    await autoSeoSweep(db.pool, q);
    expect(await seoRuns(early.id)).toBe(0);
    expect(await seoRuns(dry.id)).toBe(0);
  });
});
