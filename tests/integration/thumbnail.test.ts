import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildEngineConfig } from "@/server/core/engine-config";
import { sha256Hex } from "@/server/core/content-hash";
import type { StageOutcome } from "@/server/core/stage-runner";
import { approveGate } from "@/server/db/approvals";
import { runStage } from "@/server/db/stage-runner-adapter";
import { loadThumbnailTab, requestThumbnail } from "@/server/db/thumbnail";
import { addContent, createVideoRow, latestContent } from "@/server/db/videos";
import type { ThumbnailInput, ThumbnailRenderer } from "@/server/providers/renderer/thumbnail-container";
import { withAttempt } from "@/worker/stages/attempt";
import type { StageDeps } from "@/worker/stages/deps";
import { thumbnailAttempt } from "@/worker/stages/thumbnail";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
let root: string;
const SESSION = { kind: "session", sessionId: "11111111-1111-4111-8111-111111111111" } as const;
const queue = { enqueue: async (id: string) => `job.${id}` };

beforeAll(async () => {
  db = await withTestDb();
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "thumb-stage-")));
});
afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  await db.pool.query("insert into sessions (id, token_hash, expires_at, absolute_expires_at) values ($1, 'thumb', clock_timestamp() + interval '1 day', clock_timestamp() + interval '7 days') on conflict (id) do nothing", [SESSION.sessionId]);
});

const long = (over: { topic?: string } = {}) => createVideoRow(db.pool, { format: "long", kind: "collage", language: "en", topic: over.topic ?? "Why the sea is salty", lengthMinMinutes: 3, lengthMaxMinutes: 8 });
const asset = async (kind: "image" | "audio" = "image", deleted = false) =>
  (await db.pool.query<{ id: string }>(
    `insert into assets (kind, original_name, mime, bytes, sha256, storage_ref, source, rights, deleted_at) values ($1, 'pic.png', 'image/png', 1, $2, 'assets/a1/main.png', 'upload', '{"attestations":["x"]}', ${deleted ? "now()" : "null"}) returning id`,
    [kind, sha256Hex(`${kind}-${Math.random()}`)],
  )).rows[0]!.id;

/** A renderer that records what it was asked and writes a small file as the card. */
function fakeThumbs(): ThumbnailRenderer & { asked: ThumbnailInput[] } {
  const asked: ThumbnailInput[] = [];
  return {
    asked,
    async draw(ctx, a) {
      asked.push(a);
      const outPath = path.join(ctx.attemptDir, a.outFile);
      writeFileSync(outPath, `card-${asked.length}`);
      return { outPath, image: "img1" };
    },
  };
}

const deps = (thumbnails?: ThumbnailRenderer) => ({ db: db.pool, root, ...(thumbnails ? { thumbnails } : {}) }) as unknown as StageDeps;
const noProvider = { call: async () => Promise.reject(new Error("no provider")) };

/** Runs the queued thumbnail stage of a video the way the worker does. */
async function runQueued(videoId: string, d: StageDeps): Promise<StageOutcome> {
  const row = (await db.pool.query<{ id: string; input_hash: string }>("select id, input_hash from stage_runs where video_id = $1 and name = 'thumbnail' and status = 'queued' order by created_at desc limit 1", [videoId])).rows[0]!;
  const fin = { db: db.pool, root } as never;
  return runStage(db.pool, { provider: noProvider, ttlMs: 60_000, workerId: "w1", handler: withAttempt(fin, thumbnailAttempt(d)), config: buildEngineConfig(new Map()) }, { stageRunId: row.id, inputHash: row.input_hash });
}

describe("requestThumbnail", () => {
  it("queues one run for a long video, with the chosen picture in its request, and audits it", async () => {
    const v = await long();
    const a = await asset();
    const r = await requestThumbnail(db.pool, queue, v.id, { assetId: a, sessionId: SESSION.sessionId });
    expect(r.ok).toBe(true);
    const run = (await db.pool.query("select status, result from stage_runs where video_id = $1 and name = 'thumbnail'", [v.id])).rows[0];
    expect(run).toMatchObject({ status: "queued", result: { request: { assetId: a } } });
    expect((await db.pool.query("select detail from audit_log where event = 'video.thumbnail_requested'")).rows[0].detail).toMatchObject({ videoId: v.id, ownPicture: true });
  });
  it("refuses a short video, a cancelled one, an unknown video, a missing, deleted or non-image picture, and a second request while one is queued", async () => {
    const s = await createVideoRow(db.pool, { format: "short", kind: "collage", language: "en", topic: "t" });
    expect(await requestThumbnail(db.pool, queue, s.id)).toMatchObject({ ok: false, message: expect.stringMatching(/long video/) });
    const c = await long();
    await db.pool.query("update videos set status = 'cancelled' where id = $1", [c.id]);
    expect(await requestThumbnail(db.pool, queue, c.id)).toMatchObject({ ok: false, message: expect.stringMatching(/cancelled/) });
    expect(await requestThumbnail(db.pool, queue, "00000000-0000-4000-8000-000000000000")).toMatchObject({ ok: false });
    const v = await long();
    for (const bad of ["00000000-0000-4000-8000-000000000001", "not-a-uuid", await asset("audio"), await asset("image", true)]) {
      expect(await requestThumbnail(db.pool, queue, v.id, { assetId: bad }), bad).toMatchObject({ ok: false });
    }
    expect((await db.pool.query("select count(*)::int n from stage_runs where name = 'thumbnail'")).rows[0].n).toBe(0);
    expect((await requestThumbnail(db.pool, queue, v.id)).ok).toBe(true);
    expect(await requestThumbnail(db.pool, queue, v.id)).toMatchObject({ ok: false, message: expect.stringMatching(/already being drawn/) });
  });
});

describe("thumbnail stage", () => {
  it("draws the card from the topic, saves it as a thumbnail content version, and prefers a saved upload title", async () => {
    const v = await long();
    const t = fakeThumbs();
    await requestThumbnail(db.pool, queue, v.id);
    expect((await runQueued(v.id, deps(t))).kind).toBe("committed");
    expect(t.asked).toEqual([{ title: "Why the sea is salty", seed: v.id, outFile: "thumbnail.png" }]);
    const c = await latestContent(db.pool, v.id, "thumbnail");
    expect(c).toMatchObject({ version: 1, filePath: `videos/${v.id}/thumbnail.png` });
    expect(c?.sha256).toBe(sha256Hex("card-1"));
    expect(readFileSync(path.join(root, "videos", v.id, "thumbnail.png"), "utf8")).toBe("card-1");

    await addContent(db.pool, v.id, "metadata", { body: { title: "Why Is The Sea Salty? The Real Answer" }, sha256: sha256Hex("m1") });
    await requestThumbnail(db.pool, queue, v.id);
    await runQueued(v.id, deps(t));
    expect(t.asked[1]!.title).toBe("Why Is The Sea Salty? The Real Answer");
    expect((await latestContent(db.pool, v.id, "thumbnail"))?.version).toBe(2);
  });
  it("puts the owner's picture on the card (its storage ref), and fails plainly when the picture is gone", async () => {
    const v = await long();
    const a = await asset();
    const t = fakeThumbs();
    await requestThumbnail(db.pool, queue, v.id, { assetId: a });
    await runQueued(v.id, deps(t));
    expect(t.asked[0]).toMatchObject({ pictureRef: "assets/a1/main.png" });
    await requestThumbnail(db.pool, queue, v.id, { assetId: a });
    await db.pool.query("update assets set deleted_at = now() where id = $1", [a]);
    const out = await runQueued(v.id, deps(t));
    expect(out.kind).toBe("known_failure");
    expect(t.asked).toHaveLength(1);
    expect((await latestContent(db.pool, v.id, "thumbnail"))?.version).toBe(1);
  });
  it("refuses a card over YouTube's 2 MB limit, so one that can never be sent is never offered for approval", async () => {
    const v = await long();
    const big: ThumbnailRenderer = { async draw(ctx, a) { const outPath = path.join(ctx.attemptDir, a.outFile); writeFileSync(outPath, Buffer.alloc(2 * 1024 * 1024 + 1)); return { outPath, image: "img1" }; } };
    await requestThumbnail(db.pool, queue, v.id);
    expect((await runQueued(v.id, deps(big))).kind).toBe("known_failure");
    expect(await latestContent(db.pool, v.id, "thumbnail")).toBeNull();
  });
  it("fails plainly when no renderer is wired", async () => {
    const v = await long();
    await requestThumbnail(db.pool, queue, v.id);
    expect((await runQueued(v.id, deps())).kind).toBe("known_failure");
    expect(await latestContent(db.pool, v.id, "thumbnail")).toBeNull();
  });
});

describe("thumbnail panel data and the gate", () => {
  it("shows nothing approved until the owner approves exactly this card, and a new card voids it", async () => {
    const v = await long();
    const t = fakeThumbs();
    expect(await loadThumbnailTab(db.pool, v.id)).toMatchObject({ hasCard: false, approved: false, seenHash: null, busy: false });
    await requestThumbnail(db.pool, queue, v.id);
    expect((await loadThumbnailTab(db.pool, v.id)).busy).toBe(true);
    await runQueued(v.id, deps(t));
    const tab = await loadThumbnailTab(db.pool, v.id);
    expect(tab).toMatchObject({ hasCard: true, approved: false, busy: false, failed: false });
    expect(tab.seenHash).toMatch(/^[0-9a-f]{64}$/);

    expect(await approveGate(db.pool, { videoId: v.id, gate: "thumbnail", seenHash: tab.seenHash!, actor: SESSION })).toMatchObject({ ok: true });
    expect((await loadThumbnailTab(db.pool, v.id)).approved).toBe(true);

    await requestThumbnail(db.pool, queue, v.id);
    await runQueued(v.id, deps(t));
    const again = await loadThumbnailTab(db.pool, v.id);
    expect(again.approved).toBe(false);
    expect(again.seenHash).not.toBe(tab.seenHash);
    expect(await approveGate(db.pool, { videoId: v.id, gate: "thumbnail", seenHash: tab.seenHash!, actor: SESSION })).toMatchObject({ ok: false }); // the old hash is stale
  });
  it("lists the owner's live images to pick from, not audio or deleted ones", async () => {
    const v = await long();
    const img = await asset();
    await asset("audio");
    await asset("image", true);
    expect((await loadThumbnailTab(db.pool, v.id)).pictures).toEqual([{ id: img, name: "pic.png" }]);
  });
});
