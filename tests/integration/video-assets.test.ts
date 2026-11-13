import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RIGHTS_TEXT } from "@/server/core/asset-rules";
import { buildSceneDoc } from "@/server/core/scene-build";
import { registerAsset, type RegisterInput } from "@/server/db/assets";
import { assetsForVideo, creditsForVideo, linkAsset, LinkRefused, unlinkAll } from "@/server/db/video-assets";
import { createVideoRow } from "@/server/db/videos";
import { productionStageDeps } from "@/worker/handlers";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
beforeAll(async () => (db = await withTestDb()));
afterAll(async () => db?.stop());
beforeEach(async () => {
  await db.reset();
});

let n = 0;
const make = async (o: Partial<RegisterInput> = {}) =>
  (
    await registerAsset(db.pool, {
      kind: "image", originalName: `p${n}.png`, mime: "image/png", bytes: 10, sha256: (++n).toString(16).padStart(64, "0"),
      storageRef: `assets/j${n}/main.png`, rights: { attestations: [{ at: new Date().toISOString(), text: RIGHTS_TEXT }] }, ...o,
    })
  ).asset;
const video = async () => (await createVideoRow(db.pool, { format: "short", kind: "collage", language: "en", topic: "t" })).id;

describe("video_assets", () => {
  it("links, lists in position order with credit, and is idempotent", async () => {
    const v = await video();
    const a = await make({ caption: "A cat" });
    const b = await make();
    await linkAsset(db.pool, { videoId: v, assetId: b.id, beatId: "b1", position: 1, credit: "Photo by X" });
    await linkAsset(db.pool, { videoId: v, assetId: a.id, beatId: "b1", position: 0 });
    await linkAsset(db.pool, { videoId: v, assetId: a.id, beatId: "b1", position: 0 });
    const list = await assetsForVideo(db.pool, v);
    expect(list.map((x) => x.assetId)).toEqual([a.id, b.id]);
    expect(list[0]).toMatchObject({ caption: "A cat" });
    expect(list[1]).toMatchObject({ credit: "Photo by X" });
    expect(await creditsForVideo(db.pool, v)).toEqual(["Photo by X"]);
  });
  it("refuses a missing asset, an audio asset and a bad beat id", async () => {
    const v = await video();
    const audio = await make({ kind: "audio", mime: "audio/wav" });
    await expect(linkAsset(db.pool, { videoId: v, assetId: "00000000-0000-4000-8000-000000000000", beatId: "b1" })).rejects.toBeInstanceOf(LinkRefused);
    await expect(linkAsset(db.pool, { videoId: v, assetId: audio.id, beatId: "b1" })).rejects.toBeInstanceOf(LinkRefused);
    const img = await make();
    await expect(linkAsset(db.pool, { videoId: v, assetId: img.id, beatId: "" })).rejects.toBeInstanceOf(LinkRefused);
    await expect(linkAsset(db.pool, { videoId: v, assetId: img.id, beatId: "x".repeat(65) })).rejects.toBeInstanceOf(LinkRefused);
  });
  it("allows 6 pictures per beat and 40 per video", async () => {
    const v = await video();
    const imgs = [];
    for (let i = 0; i < 41; i++) imgs.push(await make());
    for (let i = 0; i < 6; i++) await linkAsset(db.pool, { videoId: v, assetId: imgs[i]!.id, beatId: "b1" });
    await expect(linkAsset(db.pool, { videoId: v, assetId: imgs[6]!.id, beatId: "b1" })).rejects.toBeInstanceOf(LinkRefused);
    for (let i = 6; i < 40; i++) await linkAsset(db.pool, { videoId: v, assetId: imgs[i]!.id, beatId: `b${2 + (i % 8)}` });
    await expect(linkAsset(db.pool, { videoId: v, assetId: imgs[40]!.id, beatId: "b9" })).rejects.toBeInstanceOf(LinkRefused);
    await unlinkAll(db.pool, v);
    expect(await assetsForVideo(db.pool, v)).toEqual([]);
  });
  it("Build uses linked pictures: story_kenburns with the right id and one fewer model call", async () => {
    const v = await video();
    const a = await make();
    await linkAsset(db.pool, { videoId: v, assetId: a.id, beatId: "b1" });
    const links = await assetsForVideo(db.pool, v);
    const calls: string[] = [];
    const ask = async (m: Array<{ content: string }>) => {
      calls.push(m[0]!.content);
      return JSON.stringify({ version: 1, scenes: [{ id: "s1", kind: "story_kenburns", beat: "b1", startMs: 0, durationMs: 3000, image: a.id, caption: "A cat" }] });
    };
    const doc = await buildSceneDoc([{ id: "b1", text: "Cats purr softly." }], ask as never, { pictures: { b1: links.map((l) => l.assetId) }, language: "en" });
    expect(calls).toHaveLength(1);
    expect(doc.scenes[0]).toMatchObject({ kind: "story_kenburns", image: a.id });
  });
  it("production deps expose the linked ids to Build and repair; none gives []", async () => {
    const v = await video();
    const deps = productionStageDeps(db.pool);
    expect(await deps.sceneAssets!(v)).toEqual([]);
    const a = await make();
    await linkAsset(db.pool, { videoId: v, assetId: a.id, beatId: "b1" });
    expect(await deps.sceneAssets!(v)).toEqual([a.id]);
    expect(await deps.scenePictures!(v)).toMatchObject([{ assetId: a.id, beatId: "b1" }]);
  });
});
