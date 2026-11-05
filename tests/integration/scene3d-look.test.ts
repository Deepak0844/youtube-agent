import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import { LOOK_SEND_BACK_CAP } from "@/server/core/scene3d-view";
import { buildPreviewsBody, pickStills } from "@/server/core/scene3d-stills";
import { versionsKey, type GateInput } from "@/server/core/queue-input";
import { approvalReaders, lookFeedbackOf } from "@/server/db/approval-readers";
import { approveGate, liveGateHash } from "@/server/db/approvals";
import { advanceVideo, readNextAction } from "@/server/db/pipeline";
import { decideGate, type Queues } from "@/server/db/queue-actions";
import { loadQueue, type GateItem } from "@/server/db/queue-data";
import { claimStage, commitStage } from "@/server/db/stages";
import { addContent, createVideoRow } from "@/server/db/videos";
import { scene3dSchema } from "@/shared/scene3d";
import { withTestDb, type TestDb } from "../support/db";

// The Look gate of a 3D story through the real engine, approvals and queue actions. Stages are "run" by hand (claim + commit) and the
// content a stage would save is added between, so no model, voice or renderer is needed.
let db: TestDb;
beforeAll(async () => {
  db = await withTestDb();
});
afterAll(async () => {
  await db?.stop();
});

const SESSION_ID = "0190f3a2-7c1e-7a55-9d3b-2f6c8a1b4e92";
const actor = { kind: "session", sessionId: SESSION_ID } as const;
const calls: string[] = [];
const queues: Queues = { stage: { enqueue: async (id, fence, seq) => (calls.push(id), `stage.${id}.${fence}.${seq}`) }, upload: { enqueueUpload: async (id) => `upload.${id}` } };

beforeEach(async () => {
  await db.reset();
  calls.length = 0;
  await db.ownerPool.query("insert into sessions (id, token_hash, expires_at, absolute_expires_at) values ($1, 'look-test', clock_timestamp() + interval '1 day', clock_timestamp() + interval '7 days')", [SESSION_ID]);
});

const advance = (id: string) => advanceVideo(db.pool, queues.stage, id, approvalReaders);
const nextOf = (id: string) => readNextAction(db.pool, id, approvalReaders);
const put = (id: string, kind: Parameters<typeof addContent>[2], body: unknown) => addContent(db.pool, id, kind, { body, sha256: sha256Hex(canonicalJson(body)) });

const scene = scene3dSchema.parse({ version: 2, elements: [{ kind: "box", id: "b", size_m: [2, 2, 2] }], shots: ["hook", "setup", "dig", "load", "pour", "reveal"].map((id) => ({ id, duration_s: 6, focus: "b", caption: id })) });
const picks = pickStills(scene);
let n = 0;
const previewsBody = () => buildPreviewsBody({ sceneSha256: sha256Hex(`scene-${++n}`), picks, shas: picks.map((_, i) => sha256Hex(`png-${n}-${i}`)), advice: { status: "done", notes: ["Image 2 is mostly empty sky."] } });

/** Runs the queued run of `stage` the way a worker would (claim, commit with no result). */
async function work(videoId: string, stage: string): Promise<void> {
  const q = await db.pool.query<{ id: string; input_hash: string }>("select id, input_hash from stage_runs where video_id = $1 and name = $2 and status = 'queued' order by created_at desc limit 1", [videoId, stage]);
  const c = await claimStage(db.pool, { id: q.rows[0]!.id, inputHash: q.rows[0]!.input_hash, workerId: "w1", ttlMs: 60_000 });
  await commitStage(db.pool, c!, {});
}

/** A scene3d video with an approved script, driven until the pipeline waits at the Look. */
async function atLook(videoId?: string): Promise<string> {
  let id = videoId;
  if (!id) {
    id = (await createVideoRow(db.pool, { format: "short", kind: "scene3d", language: "en", topic: "How land is made from the sea" })).id;
    await put(id, "script", { title: "t", narration: "n", story: [] });
    await put(id, "beats", { beats: [{ id: "hook", text: "x" }] });
    await advance(id);
    await work(id, "draft");
    await advance(id);
    expect((await nextOf(id))).toMatchObject({ kind: "wait_gate", gate: "script" });
    const live = await liveGateHash(db.pool, id, "script");
    expect((await approveGate(db.pool, { videoId: id, gate: "script", seenHash: live!.hash, actor })).ok).toBe(true);
  }
  for (let i = 0; i < 12; i++) {
    await advance(id);
    const a = await nextOf(id);
    if (a?.kind === "wait_gate") return id;
    if (a?.kind !== "wait_stage") throw new Error(`unexpected ${JSON.stringify(a)}`);
    await work(id, a.stage);
    if (a.stage === "direct_scene3d") await put(id, "scenes", { kind: "scene3d", scene: { n: ++n }, missing_assets: [{ beat: "dig", wanted: "an excavator", substitute: "a dump truck" }] });
    if (a.stage === "tts") await put(id, "narration", { file: `narration-${++n}.mp3` });
    if (a.stage === "scene3d_stills") await put(id, "previews", previewsBody());
  }
  throw new Error("never reached the look");
}

const inputFor = async (id: string, note?: string): Promise<GateInput> => {
  const live = await liveGateHash(db.pool, id, "look");
  return { videoId: id, gate: "look", seenHash: live!.hash, seenVersions: versionsKey(live!.versions), note };
};

describe("the look gate (3D story)", () => {
  it("the pipeline stops at the look after the preview pictures and does not queue Render", async () => {
    const id = await atLook();
    expect(await nextOf(id)).toMatchObject({ kind: "wait_gate", gate: "look" });
    const runs = (await db.pool.query<{ name: string }>("select name from stage_runs where video_id = $1 order by created_at", [id])).rows.map((r) => r.name);
    expect(runs).toEqual(["draft", "direct_scene3d", "tts", "scene3d_stills"]);
  });

  it("the queue shows a look card with the pictures, their shots and times, the missing-asset report and the advice", async () => {
    const id = await atLook();
    const item = (await loadQueue(db.pool)).items.find((i): i is GateItem => i.kind === "gate" && i.videoId === id)!;
    expect(item.gate).toBe("look");
    expect(item.hash).toBe((await liveGateHash(db.pool, id, "look"))!.hash);
    const c = item.content;
    if (c.kind !== "look" || !c.view.ok) throw new Error("expected a readable look");
    expect(c.view.look.stills).toHaveLength(picks.length);
    expect(c.view.look.stills[0]).toMatchObject({ shot: "hook", file: "stills/01.png" });
    expect(c.view.look.missing).toEqual([{ beat: "dig", wanted: "an excavator", substitute: "a dump truck" }]);
    expect(c.view.look.advice).toEqual({ status: "done", notes: ["Image 2 is mostly empty sky."] });
    expect(c.sentBack).toBe(0);
    expect(c.cap).toBe(LOOK_SEND_BACK_CAP);
  });

  it("approving the look lets Render be queued; it is queued by the very next advance", async () => {
    const id = await atLook();
    expect(await decideGate(db.pool, queues, actor, await inputFor(id), "approve")).toEqual({ ok: true, message: "Approved." });
    expect((await db.pool.query("select 1 from stage_runs where video_id = $1 and name = 'render' and status = 'queued'", [id])).rowCount).toBe(1);
    expect((await db.pool.query("select decision from approvals where video_id = $1 and gate = 'look'", [id])).rows).toEqual([{ decision: "approved" }]);
  });

  it("new preview pictures void the approval: the pipeline asks again, and Render is not queued by an advance", async () => {
    const id = await atLook();
    const first = await inputFor(id);
    expect((await decideGate(db.pool, queues, actor, first, "approve")).ok).toBe(true);
    await put(id, "previews", previewsBody()); // the pictures changed after the approval
    expect(await nextOf(id)).toMatchObject({ kind: "wait_gate", gate: "look" });
    // the page the owner had open (old hash) cannot approve the new pictures
    const stale = await decideGate(db.pool, queues, actor, first, "approve");
    expect(stale.ok).toBe(false);
    expect(stale.message).toMatch(/changed while you were looking/i);
    expect((await decideGate(db.pool, queues, actor, await inputFor(id), "approve")).ok).toBe(true);
  });

  it("a send-back needs a note, runs the director again with it, and ends at a fresh look", async () => {
    const id = await atLook();
    expect((await decideGate(db.pool, queues, actor, await inputFor(id), "send_back")).ok).toBe(false); // no note
    const r = await decideGate(db.pool, queues, actor, await inputFor(id, "more palm trees on the island"), "send_back");
    expect(r).toMatchObject({ ok: true, message: expect.stringContaining("director will redo") });
    expect(await lookFeedbackOf(db.pool, id)).toEqual({ count: 1, note: "more palm trees on the island" });
    // the director is queued again at once (the send-back made its input hash different); Render never is
    expect((await db.pool.query("select count(*)::int as n from stage_runs where video_id = $1 and name = 'direct_scene3d'", [id])).rows[0].n).toBe(2);
    expect((await db.pool.query("select 1 from stage_runs where video_id = $1 and name = 'render'", [id])).rowCount).toBe(0);
    const again = await atLook(id);
    expect(again).toBe(id);
    expect((await db.pool.query("select count(*)::int as n from stage_runs where video_id = $1 and name = 'scene3d_stills'", [id])).rows[0].n).toBe(2);
    const item = (await loadQueue(db.pool)).items.find((i): i is GateItem => i.kind === "gate" && i.videoId === id)!;
    expect(item.sentBackNote).toBeNull(); // the new pictures are new content: the old send-back does not hang over them
    expect(item.content).toMatchObject({ kind: "look", sentBack: 1 });
  });

  it("allows three send-backs, then refuses the fourth with a plain message and records nothing", async () => {
    const id = await atLook();
    for (let k = 1; k <= LOOK_SEND_BACK_CAP; k++) {
      expect((await decideGate(db.pool, queues, actor, await inputFor(id, `change number ${k}`), "send_back")).ok, `send-back ${k}`).toBe(true);
      await atLook(id);
    }
    const fourth = await decideGate(db.pool, queues, actor, await inputFor(id, "one more change"), "send_back");
    expect(fourth.ok).toBe(false);
    expect(fourth.message).toMatch(/already sent this look back 3 times/);
    expect((await db.pool.query("select count(*)::int as n from approvals where video_id = $1 and gate = 'look' and decision = 'sent_back'", [id])).rows[0].n).toBe(3);
    // approving is still possible
    expect((await decideGate(db.pool, queues, actor, await inputFor(id), "approve")).ok).toBe(true);
  });

  it("another video kind never waits at the look", async () => {
    const v = await createVideoRow(db.pool, { format: "short", kind: "scene_kit", language: "en", topic: "t" });
    await put(v.id, "script", { title: "t", narration: "n" });
    await advance(v.id);
    await work(v.id, "draft");
    await advance(v.id);
    expect(await nextOf(v.id)).toMatchObject({ kind: "wait_gate", gate: "script" });
    expect(await liveGateHash(db.pool, v.id, "look")).toBeNull();
  });
});
