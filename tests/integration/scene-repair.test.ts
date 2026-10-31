import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import { expectedInputHash, type PipelineView } from "@/server/core/pipeline-plan";
import type { EnqueueOnly } from "@/server/db/pipeline";
import { currentScenes, recheckScenes, repairScenes, requestSceneRepair, undoScenes } from "@/server/db/scene-repair";
import { addContent, createVideoRow } from "@/server/db/videos";
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
});

const sc = (id: string, beat: string, startMs: number, text: string) => ({ id, kind: "terminal", beat, startMs, durationMs: 3000, lines: [{ text }] });
const good = { version: 1, scenes: [sc("s1", "b1", 0, "ls"), sc("s2", "b2", 3000, "pwd")] };
const badDoc = { version: 1, scenes: [sc("s1", "b1", 0, "ls"), sc("s2", "b2", 3000, "like and subscribe now")] };
const reply = (scene: object) => JSON.stringify({ version: 1, scenes: [scene] });

async function setup(...bodies: object[]) {
  const v = await createVideoRow(db.pool, { format: "short", kind: "scene_kit", language: "en", topic: "t" });
  await addContent(db.pool, v.id, "beats", { body: { beats: [{ id: "b1", text: "a" }, { id: "b2", text: "b" }] }, sha256: sha256Hex("beats") });
  for (const b of bodies) await addContent(db.pool, v.id, "scenes", { body: b, sha256: sha256Hex(canonicalJson(b)) });
  return v.id;
}
const versions = async (id: string) => (await db.pool.query("select version from video_content where video_id = $1 and kind = 'scenes' order by version", [id])).rows.length;
const spend = async () => (await db.pool.query("select count(*)::int as n from spend_intents")).rows[0].n;

describe("recheckScenes", () => {
  it("finds the CTA-wording scene, costs nothing, adds no version", async () => {
    const id = await setup(badDoc);
    const r = await recheckScenes(db.pool, id);
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/^scene 2:/m);
    expect(await spend()).toBe(0);
    expect(await versions(id)).toBe(1);
    const a = await db.pool.query("select detail from audit_log where event = 'scenes.rechecked'");
    expect(a.rows).toHaveLength(1);
  });
  it("passes a clean document", async () => {
    expect((await recheckScenes(db.pool, await setup(good))).ok).toBe(true);
  });
});

describe("repairScenes", () => {
  it("fixes only the failing scene into a NEW version; the other scene is byte-identical", async () => {
    const id = await setup(badDoc);
    const r = await repairScenes(db.pool, id, async () => reply(sc("x", "x", 0, "Two plus two")));
    expect(r).toMatchObject({ ok: true, version: 2, changed: ["s2"] });
    const v1 = (await db.pool.query("select body from video_content where video_id=$1 and kind='scenes' and version=1", [id])).rows[0].body;
    const cur = await currentScenes(db.pool, id);
    expect(JSON.stringify(cur!.body.scenes[0])).toBe(JSON.stringify(v1.scenes[0]));
    expect(v1).toEqual(badDoc);
    expect(cur!.meta?.changed).toEqual(["s2"]);
    expect((await recheckScenes(db.pool, id)).ok).toBe(true);
  });
  it("a repair that cannot be fixed leaves the version untouched", async () => {
    const id = await setup(badDoc);
    const r = await repairScenes(db.pool, id, async () => reply(sc("s2", "b2", 3000, "subscribe")));
    expect(r.ok).toBe(false);
    expect(await versions(id)).toBe(1);
  });
  it("makes no model call when nothing fails", async () => {
    const id = await setup(good);
    let calls = 0;
    const r = await repairScenes(db.pool, id, async () => (calls++, ""));
    expect(r.ok).toBe(false);
    expect(calls).toBe(0);
  });
});

describe("undoScenes", () => {
  it("restores the previous version as a new newest one, and again goes one more step back", async () => {
    const id = await setup(good, badDoc, good);
    const u1 = await undoScenes(db.pool, id);
    expect(u1).toMatchObject({ ok: true, version: 4, restored: 2 });
    expect((await currentScenes(db.pool, id))!.body).toEqual(badDoc);
    const u2 = await undoScenes(db.pool, id);
    expect(u2).toMatchObject({ ok: true, version: 5, restored: 1 });
    expect((await currentScenes(db.pool, id))!.body).toEqual(good);
    expect(await versions(id)).toBe(5);
    expect((await undoScenes(db.pool, id)).ok).toBe(false);
    expect(await spend()).toBe(0);
  });
  it("refuses with one version", async () => {
    const id = await setup(good);
    expect(await undoScenes(db.pool, id)).toMatchObject({ ok: false });
    expect(await versions(id)).toBe(1);
  });
  it("changes the render's wanted input hash (render goes stale)", async () => {
    const id = await setup(good, badDoc);
    const view = (sha: string): PipelineView => ({ kind: "scene_kit", format: "short", flags: {}, paramsHash: "p", feedback: null, content: { scenes: sha }, runs: {}, approved: new Set() }) as unknown as PipelineView;
    const before = expectedInputHash(view((await currentScenes(db.pool, id))!.body ? sha256Hex(canonicalJson(badDoc)) : ""), "render", "prev");
    await undoScenes(db.pool, id);
    const row = (await db.pool.query("select sha256 from video_content where video_id=$1 and kind='scenes' order by version desc limit 1", [id])).rows[0];
    expect(expectedInputHash(view(row.sha256), "render", "prev")).not.toBe(before);
  });
});

describe("requestSceneRepair", () => {
  const mkQueue = () => {
    const jobs: string[] = [];
    const enqueue = (async (id: string) => void jobs.push(id)) as unknown as EnqueueOnly["enqueue"];
    return { jobs, enqueue };
  };
  const runs = async (id: string) => (await db.pool.query("select status, result from stage_runs where video_id = $1 and name = 'repair_scenes'", [id])).rows;

  it("queues exactly one repair_scenes run, remembers the scene ids, writes an audit row and spends nothing", async () => {
    const id = await setup(badDoc);
    const q = mkQueue();
    const r = await requestSceneRepair(db.pool, q, id, ["s2"], "11111111-1111-4111-8111-111111111111");
    expect(r.ok).toBe(true);
    expect(q.jobs).toHaveLength(1);
    const rows = await runs(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "queued", result: { request: { sceneIds: ["s2"] } } });
    expect((await db.pool.query("select 1 from audit_log where event = 'scenes.repair_requested'")).rowCount).toBe(1);
    expect(await spend()).toBe(0);
    expect(await versions(id)).toBe(1);
  });
  it("refuses a second request while one is queued", async () => {
    const id = await setup(badDoc);
    const q = mkQueue();
    await requestSceneRepair(db.pool, q, id);
    const r = await requestSceneRepair(db.pool, q, id);
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/already queued or running/) });
    expect(await runs(id)).toHaveLength(1);
    expect(q.jobs).toHaveLength(1);
  });
  it("refuses when there are no scenes", async () => {
    const id = await setup();
    const r = await requestSceneRepair(db.pool, mkQueue(), id);
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/no scenes/) });
    expect(await runs(id)).toHaveLength(0);
  });
  it("refuses when the video is not live", async () => {
    const id = await setup(badDoc);
    await db.pool.query("update videos set status = 'cancelled' where id = $1", [id]);
    const r = await requestSceneRepair(db.pool, mkQueue(), id);
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/no longer in production/) });
    expect(await runs(id)).toHaveLength(0);
  });
});
