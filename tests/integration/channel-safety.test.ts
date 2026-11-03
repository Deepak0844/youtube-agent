import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@/server/core/content-hash";
import { uuidv7 } from "@/server/core/ids";
import { UPLOAD_CAPS } from "@/server/core/publish-rules";
import { approveGate, liveGateHash } from "@/server/db/approvals";
import { approvePublish } from "@/server/db/publish";
import { setSetting } from "@/server/db/settings";
import { saveUploadSwitches } from "@/server/db/system-settings";
import { addContent, createVideoRow } from "@/server/db/videos";
import { saveChannelSettings } from "@/server/db/youtube-channels";
import { createFakeUploader } from "@/server/providers/uploader/fake";
import type { UploadQueue } from "@/server/queue/job-queue";
import { handlePublishUpload } from "@/worker/stages/publish-upload";
import { withTestDb, type TestDb } from "../support/db";

// Phase 5 slice 2: per-channel safety switches, the kill switch and the cutover, enforced where bytes could leave
// (approvePublish, readUploadTarget, the start transaction, startUpload's caps). Uses the fake uploader only.

let db: TestDb;
let root: string;
beforeAll(async () => {
  db = await withTestDb();
});
beforeEach(async () => {
  await db.reset();
  root = mkdtempSync(path.join(tmpdir(), "chan-safety-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
afterAll(async () => {
  await db?.stop();
});

const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const queue = () => ({ enqueueUpload: vi.fn(async (id: string) => `upload.${id}`) }) as unknown as UploadQueue;
const CH = "UC-test";

async function newSession(): Promise<string> {
  const id = uuidv7();
  await db.pool.query(
    "insert into sessions (id, token_hash, expires_at, absolute_expires_at) values ($1, $2, clock_timestamp() + interval '1 hour', clock_timestamp() + interval '7 days')",
    [id, `t-${id}`],
  );
  return id;
}

/** A connected channel row with the safe defaults (the migration's), optionally changed with `set` (raw owner SQL). */
async function channel(set = ""): Promise<string> {
  const a = await db.ownerPool.query<{ id: string }>("insert into google_accounts (google_sub, email) values ($1, 'a@example.com') on conflict (google_sub) do update set email = excluded.email returning id", ["sub-1"]);
  const c = await db.ownerPool.query<{ id: string }>(
    "insert into youtube_channels (google_account_id, channel_id, title, token_secret_name, status) values ($1, $2, 'T', 'tok-1', 'connected') returning id",
    [a.rows[0]!.id, CH],
  );
  if (set) await db.ownerPool.query(`update youtube_channels set ${set} where id = $1`, [c.rows[0]!.id]);
  return c.rows[0]!.id;
}

async function seed(visibility = "private") {
  const v = await createVideoRow(db.pool, { format: "short", kind: "scene_kit", language: "en", topic: "t", channelId: CH });
  const bytes = Buffer.from(`video-bytes-${v.id}`);
  const filePath = `videos/${v.id}/final.mp4`;
  mkdirSync(path.join(root, "videos", v.id), { recursive: true });
  writeFileSync(path.join(root, filePath), bytes);
  await addContent(db.pool, v.id, "video", { filePath, sha256: sha(bytes) });
  await addContent(db.pool, v.id, "evidence", { filePath: "e/1.pdf", sha256: sha256Hex("evidence") });
  await addContent(db.pool, v.id, "metadata", { body: { title: "t", visibility, publish_at: null }, sha256: sha256Hex("meta") });
  const sessionId = await newSession();
  const actor = { kind: "session", sessionId } as const;
  await approveGate(db.pool, { videoId: v.id, gate: "video", seenHash: (await liveGateHash(db.pool, v.id, "video"))!.hash, actor });
  await approveGate(db.pool, { videoId: v.id, gate: "evidence", seenHash: (await liveGateHash(db.pool, v.id, "evidence"))!.hash, actor });
  return { videoId: v.id, sessionId };
}
type Seed = Awaited<ReturnType<typeof seed>>;

async function approve(s: Seed, visibility = "private") {
  const seenHash = (await liveGateHash(db.pool, s.videoId, "publish"))!.hash;
  return approvePublish(db.pool, queue(), { videoId: s.videoId, seenHash, visibility: visibility as "private", publishAt: null, channelId: CH, actor: { kind: "session", sessionId: s.sessionId } }, { root });
}
async function approved(visibility = "private"): Promise<string> {
  const res = await approve(await seed(visibility), visibility);
  if (!res.ok) throw new Error(`fixture approval refused: ${res.reason}`);
  return res.uploadId;
}
const run = (uploadId: string, uploader = createFakeUploader(), afterRead?: () => Promise<void>) =>
  handlePublishUpload(db.pool, { uploader, root, caps: { ...UPLOAD_CAPS }, afterRead }, uploadId).then((r) => ({ ...r, uploader }));
const status = async (id: string) => (await db.pool.query("select status from uploads where id = $1", [id])).rows[0].status as string;
const refusals = async (uploadId: string) =>
  (await db.pool.query("select detail from audit_log where event = 'upload.refused' order by id")).rows.map((r) => r.detail).filter((d) => d.uploadId === uploadId);
const audits = async (prefix: string) => (await db.pool.query("select event, detail from audit_log where event like $1 order by id", [`${prefix}%`])).rows;

describe("kill switch", () => {
  it("refuses an approval while on", async () => {
    await channel();
    await saveUploadSwitches(db.pool, { killSwitch: true });
    const res = await approve(await seed());
    expect(res).toMatchObject({ ok: false });
    expect(!res.ok && res.reason).toMatch(/kill switch/);
    expect((await db.pool.query("select 1 from uploads")).rowCount).toBe(0);
  });
  it("stops an approved upload at job time, and one flipped between the read and the start", async () => {
    await channel();
    const id = await approved();
    await saveUploadSwitches(db.pool, { killSwitch: true });
    const r = await run(id);
    expect(r.started).toBe(false);
    expect(r.uploader.totalCalls()).toBe(0);
    expect(await status(id)).toBe("publish_approved");
    expect((await refusals(id)).at(-1)).toMatchObject({ reason: "policy", detail: expect.stringMatching(/kill switch/) });

    await saveUploadSwitches(db.pool, { killSwitch: false });
    const r2 = await run(id, createFakeUploader(), () => saveUploadSwitches(db.pool, { killSwitch: true }).then(() => undefined));
    expect(r2.started).toBe(false);
    expect(r2.uploader.totalCalls()).toBe(0);
    expect((await refusals(id)).at(-1)?.reason).toBe("policy");
  });
  it("applies even when the channel id is not a connected channel", async () => {
    await saveUploadSwitches(db.pool, { killSwitch: true });
    expect((await approve(await seed())).ok).toBe(false);
  });
});

describe("cutover for production channels", () => {
  it("blocks approval and job until the typed cutover is done", async () => {
    await channel("production = true");
    expect((await approve(await seed())).ok).toBe(false);

    await db.ownerPool.query("update youtube_channels set production = false");
    const id = await approved();
    await db.ownerPool.query("update youtube_channels set production = true");
    const blocked = await run(id);
    expect(blocked.started).toBe(false);
    expect(blocked.uploader.totalCalls()).toBe(0);
    expect((await refusals(id)).at(-1)?.reason).toBe("policy");

    expect(await saveUploadSwitches(db.pool, { cutover: true, typed: "go live" })).toMatchObject({ ok: false });
    expect(await saveUploadSwitches(db.pool, { cutover: true })).toMatchObject({ ok: false });
    expect(await saveUploadSwitches(db.pool, { cutover: true, typed: "GO LIVE" })).toMatchObject({ ok: true });
    expect((await run(id)).started).toBe(true);
    expect(await status(id)).toBe("uploaded");
  });
  it("does not block a channel that is not production", async () => {
    await channel();
    expect((await approve(await seed())).ok).toBe(true);
  });
});

describe("allow public per channel", () => {
  it("refuses public at approval and job time while the channel's allow_public is off, even with the global switch on", async () => {
    await setSetting(db.pool, "policy.allow_public", true, { actor: "session" });
    await channel("allow_public = true");
    const id = await approved("public");
    await db.ownerPool.query("update youtube_channels set allow_public = false");
    const r = await run(id);
    expect(r.started).toBe(false);
    expect(r.uploader.totalCalls()).toBe(0);
    expect((await refusals(id)).at(-1)?.reason).toBe("policy");
    expect((await approve(await seed("public"), "public")).ok).toBe(false);
    await db.ownerPool.query("update youtube_channels set allow_public = true");
    expect((await run(id)).started).toBe(true);
  });
});

describe("per-channel upload limits", () => {
  it("defaults to 2 a day, 6 hours apart, not made for kids, category 27", async () => {
    await channel();
    const r = (await db.pool.query("select * from youtube_channels")).rows[0];
    expect(r).toMatchObject({ max_uploads_per_day: 2, min_hours_between_uploads: 6, made_for_kids: false, category_id: 27, default_style: null, synthetic_disclosure_default: false, production: false, allow_public: false });
  });
  it("refuses a second upload inside the spacing window", async () => {
    await channel();
    const a = await approved();
    const b = await approved();
    expect((await run(a)).started).toBe(true);
    const second = await run(b);
    expect(second.started).toBe(false);
    expect(second.uploader.totalCalls()).toBe(0);
    expect((await refusals(b)).at(-1)?.reason).toBe("spacing");
  });
  it("refuses beyond the per-day cap even with no spacing", async () => {
    await channel("max_uploads_per_day = 1, min_hours_between_uploads = 0");
    const a = await approved();
    const b = await approved();
    expect((await run(a)).started).toBe(true);
    expect((await run(b)).started).toBe(false);
    expect((await refusals(b)).at(-1)?.reason).toBe("daily_cap");
    expect(await status(b)).toBe("publish_approved");
  });
});

describe("only the owner session changes channel switches", () => {
  const input = { production: false, allowPublic: true, madeForKids: false, synthetic: true, maxUploadsPerDay: 3, minHoursBetweenUploads: 4, language: "hi", categoryId: 27, defaultStyle: "kinetic_type" as const };
  it("a session saves and the change is audited; a token, system or malformed actor changes nothing", async () => {
    const id = await channel();
    const sessionId = await newSession();
    const r = await saveChannelSettings(db.pool, id, input, { kind: "session", sessionId });
    expect(r).toMatchObject({ ok: true });
    const row = (await db.pool.query("select * from youtube_channels where id = $1", [id])).rows[0];
    expect(row).toMatchObject({ allow_public: true, synthetic_disclosure_default: true, max_uploads_per_day: 3, min_hours_between_uploads: 4, default_language: "hi", default_style: "kinetic_type" });
    const a = (await audits("youtube.channel_settings_changed")).at(-1)!;
    expect(a.detail.changes.allowPublic).toEqual({ from: false, to: true });

    for (const actor of [{ kind: "token", sessionId }, { kind: "system" }, { kind: "session" }, { kind: "session", sessionId: "nope" }, { kind: "session", sessionId, extra: 1 }, null, undefined]) {
      const bad = await saveChannelSettings(db.pool, id, { ...input, allowPublic: false, production: true }, actor as never);
      expect(bad).toMatchObject({ ok: false });
    }
    expect((await db.pool.query("select allow_public, production from youtube_channels where id = $1", [id])).rows[0]).toEqual({ allow_public: true, production: false });
    expect(await audits("youtube.channel_settings_changed")).toHaveLength(1);
  });
  it("refuses a bad style or number and leaves the row alone", async () => {
    const id = await channel();
    const actor = { kind: "session", sessionId: await newSession() } as const;
    for (const bad of [{ ...input, defaultStyle: "not_a_style" }, { ...input, maxUploadsPerDay: -1 }, { ...input, language: "English" }, { ...input, madeForKids: undefined }]) {
      expect(await saveChannelSettings(db.pool, id, bad, actor)).toMatchObject({ ok: false });
    }
    expect((await db.pool.query("select max_uploads_per_day from youtube_channels where id = $1", [id])).rows[0].max_uploads_per_day).toBe(2);
  });
});

describe("global switches are audited", () => {
  it("writes setting.changed with old and new values", async () => {
    await saveUploadSwitches(db.pool, { killSwitch: true });
    await saveUploadSwitches(db.pool, { cutover: true, typed: "GO LIVE" });
    const rows = (await audits("setting.changed")).map((r) => r.detail).filter((d) => ["uploads.kill_switch", "youtube.cutover_done"].includes(d.setting));
    expect(rows).toEqual([
      { setting: "uploads.kill_switch", from: false, to: true },
      { setting: "youtube.cutover_done", from: false, to: true },
    ]);
  });
});
