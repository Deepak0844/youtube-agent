import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@/server/core/content-hash";
import { uuidv7 } from "@/server/core/ids";
import { approvalState, approveGate, liveGateHash } from "@/server/db/approvals";
import { approvePublish } from "@/server/db/publish";
import { loadUploadDetails, saveUploadDetails } from "@/server/db/upload-details";
import { addContent, createVideoRow, latestContent } from "@/server/db/videos";
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
      await addContent(db.pool, v.id, "evidence", { filePath: "e/1.pdf", sha256: sha256Hex("evidence") });
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
