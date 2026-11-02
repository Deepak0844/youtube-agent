import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@/server/core/content-hash";
import { forceRerunStageById, rerunStageById } from "@/server/db/video-page-actions";
import { cancelVideoById } from "@/server/db/queue-actions";
import { loadVideoPage, stageEstimates } from "@/server/db/video-page";
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

const SESSION = "0190f3a2-7c1e-7a55-9d3b-2f6c8a1b4e91";
const actor = { kind: "session", sessionId: SESSION } as const;
const queued: string[] = [];
const queue = { enqueue: async (id: string, fence: number, seq: number) => (queued.push(id), `stage.${id}.${fence}.${seq}`) };
const mk = (topic = "t") => createVideoRow(db.pool, { format: "short", kind: "scene_kit", language: "en", topic });
let n = 0;
const run = async (videoId: string, name: string, status: string, seconds = 10) => {
  const id = `0190f3a2-7c1e-7a55-9d3b-${(0x4000 + n++).toString(16).padStart(12, "0")}`;
  await db.pool.query(
    "insert into stage_runs (id, video_id, name, status, input_hash, created_at, updated_at) values ($1,$2,$3,$4,$6, now() - ($5 * interval '1 second'), now())",
    [id, videoId, name, status, seconds, `h${n}`],
  );
  return id;
};

describe("loadVideoPage", () => {
  it("returns null for an unknown video and honest empties for a new one", async () => {
    expect(await loadVideoPage(db.pool, "0190f3a2-7c1e-7a55-9d3b-2f6c8a1b4eff")).toBeNull();
    const v = await mk("fresh");
    const p = (await loadVideoPage(db.pool, v.id))!;
    expect(p.head.topic).toBe("fresh");
    expect(p.script).toBeNull();
    expect(p.qa).toBeNull();
    expect(p.log).toEqual([]);
    expect(p.spend.totalMicroUsd).toBe(0);
    expect(p.stages.every((s) => s.state === "pending")).toBe(true);
  });

  it("shows script, beats, cost plan and spend for a seeded video", async () => {
    const v = await mk("seeded");
    await addContent(db.pool, v.id, "script", { body: { title: "T", narration: "n", beats: [{ id: "a" }], evidence: [] }, sha256: sha256Hex("s") });
    await addContent(db.pool, v.id, "beats", { body: { beats: [{ id: "a", text: "x" }] }, sha256: sha256Hex("b") });
    await addContent(db.pool, v.id, "cost_plan", { body: { items: [{ kind: "image", provider: "p", quoteMicroUsd: 2_000_000 }], quote: { micro_usd: "2000000" } }, sha256: sha256Hex("c") });
    const sr = await run(v.id, "generate", "succeeded");
    await db.pool.query("insert into spend_intents (id, stage_run_id, step_index, tool_call_index, call_key, status, actual_micro_usd) values ('0190f3a2-7c1e-7a55-9d3b-2f6c8a1b4e11',$1,0,0,'k','done',1500000)", [sr]);
    const p = (await loadVideoPage(db.pool, v.id))!;
    expect(p.script).toMatchObject({ approved: false, version: 1 });
    expect(p.costPlanTotalMicroUsd).toBe(2_000_000);
    expect(p.spend.totalMicroUsd).toBe(1_500_000);
    expect(p.spend.rows).toEqual([{ stage: "generate", spentMicroUsd: 1_500_000, heldMicroUsd: 0 }]);
    expect(p.stages.find((s) => s.stage === "generate")!.state).toBe("done");
  });
});

describe("stageEstimates", () => {
  it("is null under 3 samples and the median from 3", async () => {
    const v = await mk();
    await run(v.id, "build", "succeeded", 10);
    await run(v.id, "build", "succeeded", 30);
    expect((await stageEstimates(db.pool)).build).toBeNull();
    await run(v.id, "build", "succeeded", 20);
    const e = (await stageEstimates(db.pool)).build!;
    expect(e / 1000).toBeGreaterThan(19);
    expect(e / 1000).toBeLessThan(21);
  });
});

describe("rerunStageById / cancel", () => {
  it("refuses a non-session actor and unknown stages", async () => {
    const v = await mk();
    expect((await rerunStageById(db.pool, queue, { kind: "system" } as never, v.id, "draft")).ok).toBe(false);
    expect((await rerunStageById(db.pool, queue, actor, v.id, "bogus")).ok).toBe(false);
    expect((await cancelVideoById(db.pool, { kind: "system" } as never, v.id)).ok).toBe(false);
    expect((await db.pool.query("select status from videos where id=$1", [v.id])).rows[0].status).not.toBe("cancelled");
  });

  it("queues a failed draft again and audits it", async () => {
    const v = await mk();
    await run(v.id, "draft", "failed");
    const r = await rerunStageById(db.pool, queue, actor, v.id, "draft");
    expect(r.ok).toBe(true);
    expect((await db.pool.query("select count(*)::int as n from stage_runs where video_id=$1 and name='draft' and status='queued'", [v.id])).rows[0].n).toBe(1);
    expect((await db.pool.query("select count(*)::int as n from audit_log where event='stage.rerun_requested'")).rows[0].n).toBe(1);
    expect(queued.length).toBe(1);
  });

  it("cancels the video", async () => {
    const v = await mk();
    expect((await cancelVideoById(db.pool, actor, v.id)).ok).toBe(true);
    expect((await db.pool.query("select status from videos where id=$1", [v.id])).rows[0].status).toBe("cancelled");
  });
});

describe("forceRerunStageById", () => {
  const seed = async (v: { id: string }, names = ["draft", "build", "tts", "render"]) => {
    for (const [i, name] of names.entries()) await run(v.id, name, "succeeded", 100 - i);
  };
  const count = async (id: string, name: string) => (await db.pool.query("select count(*)::int as n from stage_runs where video_id=$1 and name=$2", [id, name])).rows[0].n as number;

  it("re-runs a finished render with a new hash, audits it, and refuses a double click", async () => {
    const v = await mk();
    await seed(v);
    const before = (await db.pool.query("select input_hash from stage_runs where video_id=$1 and name='render'", [v.id])).rows[0].input_hash;
    const r = await forceRerunStageById(db.pool, queue, actor, v.id, "render");
    expect(r.ok).toBe(true);
    const rows = (await db.pool.query("select input_hash, status from stage_runs where video_id=$1 and name='render' order by created_at, id", [v.id])).rows;
    expect(rows.map((x) => x.status)).toEqual(["succeeded", "queued"]);
    expect(rows[1].input_hash).not.toBe(before);
    expect((await db.pool.query("select count(*)::int as n from audit_log where event='stage.force_rerun_requested'")).rows[0].n).toBe(1);
    const again = await forceRerunStageById(db.pool, queue, actor, v.id, "render");
    expect(again.ok).toBe(false);
    expect(await count(v.id, "render")).toBe(2);
  });
  it("refuses paid or model steps, and steps that have not finished", async () => {
    const v = await mk();
    await seed(v);
    for (const st of ["tts", "draft", "build", "generate", "repair_scenes", "voice"]) expect((await forceRerunStageById(db.pool, queue, actor, v.id, st)).ok).toBe(false);
    expect(await count(v.id, "tts")).toBe(1);
    expect(await count(v.id, "voice")).toBe(0);
  });
  it("refuses while any step is active", async () => {
    const v = await mk();
    await seed(v);
    await run(v.id, "voice", "running");
    expect((await forceRerunStageById(db.pool, queue, actor, v.id, "render")).ok).toBe(false);
    expect(await count(v.id, "render")).toBe(1);
  });
  it("refuses a video that is no longer live, and a non-session actor", async () => {
    const v = await mk();
    await seed(v);
    expect((await forceRerunStageById(db.pool, queue, { kind: "system" } as never, v.id, "render")).ok).toBe(false);
    await db.pool.query("update videos set status='cancelled' where id=$1", [v.id]);
    expect((await forceRerunStageById(db.pool, queue, actor, v.id, "render")).ok).toBe(false);
    expect(await count(v.id, "render")).toBe(1);
  });
});
