import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@/server/core/content-hash";
import { uuidv7 } from "@/server/core/ids";
import type { StageName } from "@/server/core/pipeline-plan";
import { approvalReaders } from "@/server/db/approval-readers";
import { wantedHashLocked } from "@/server/db/pipeline";
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
const mk = (topic = "t") => createVideoRow(db.pool, { format: "short", kind: "collage", language: "en", topic });
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
  // Seeds runs with the real expected hashes (so the pipeline counts them as settled). `over` sets a different status per step.
  const seed = async (v: { id: string }, names = ["draft", "build", "tts", "render"], over: Record<string, string> = {}) => {
    for (const name of names) {
      const c = await db.pool.connect();
      let hash: string | null;
      try {
        hash = await wantedHashLocked(c, v.id, name as StageName, approvalReaders);
      } finally {
        c.release();
      }
      expect(hash).not.toBeNull();
      await db.pool.query("insert into stage_runs (id, video_id, name, status, input_hash) values ($1,$2,$3,'succeeded',$4)", [uuidv7(), v.id, name, hash]);
    }
    for (const [name, status] of Object.entries(over)) await db.pool.query("update stage_runs set status = $3 where video_id = $1 and name = $2", [v.id, name, status]);
  };
  const count = async (id: string, name: string) => (await db.pool.query("select count(*)::int as n from stage_runs where video_id=$1 and name=$2", [id, name])).rows[0].n as number;
  const nonces = async (id: string) => (await db.pool.query("select stage_nonces from videos where id=$1", [id])).rows[0].stage_nonces;

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
    for (const st of ["draft", "build", "generate", "repair_scenes", "voice"]) expect((await forceRerunStageById(db.pool, queue, actor, v.id, st)).ok).toBe(false);
    expect(await count(v.id, "tts")).toBe(1);
    expect(await count(v.id, "voice")).toBe(0);
    expect(await nonces(v.id)).toEqual({});
  });
  it("refuses while any step is active", async () => {
    const v = await mk();
    await seed(v, ["draft", "build", "tts", "render", "voice"], { voice: "running" });
    expect((await forceRerunStageById(db.pool, queue, actor, v.id, "render")).ok).toBe(false);
    expect(await count(v.id, "render")).toBe(1);
    expect(await nonces(v.id)).toEqual({});
  });
  it("refuses a later step while an earlier one is failed or out of date", async () => {
    const v = await mk();
    await seed(v, ["draft", "build", "tts", "render", "voice", "sfx"], { tts: "failed" });
    const f = await forceRerunStageById(db.pool, queue, actor, v.id, "sfx");
    expect(f.ok).toBe(false);
    expect(f.message).toMatch(/settle/);
    const w = await mk("other");
    await seed(w, ["draft", "build", "tts", "render", "voice"]);
    await addContent(db.pool, w.id, "narration", { body: { n: 1 }, sha256: sha256Hex("new") }); // render's input changed: render is stale
    expect((await forceRerunStageById(db.pool, queue, actor, w.id, "voice")).ok).toBe(false);
    expect(await nonces(v.id)).toEqual({});
    expect(await nonces(w.id)).toEqual({});
  });
  it("refuses once an upload exists, but not after a failed one", async () => {
    const v = await mk();
    await seed(v);
    await db.pool.query("insert into uploads (id, video_id, status, approval_hash, file_sha) values ($1,$2,'upload_failed','a','b')", [uuidv7(), v.id]);
    const ok = await forceRerunStageById(db.pool, queue, actor, v.id, "render");
    expect(ok.ok).toBe(true);
    const w = await mk("up");
    await seed(w);
    await db.pool.query("insert into uploads (id, video_id, status, approval_hash, file_sha) values ($1,$2,'publish_approved','a','b')", [uuidv7(), w.id]);
    const r = await forceRerunStageById(db.pool, queue, actor, w.id, "render");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/uploaded/);
    expect(await nonces(w.id)).toEqual({});
  });
  it("refuses a video that is no longer live, and a non-session actor", async () => {
    const v = await mk();
    await seed(v);
    expect((await forceRerunStageById(db.pool, queue, { kind: "system" } as never, v.id, "render")).ok).toBe(false);
    await db.pool.query("update videos set status='cancelled' where id=$1", [v.id]);
    expect((await forceRerunStageById(db.pool, queue, actor, v.id, "render")).ok).toBe(false);
    expect(await count(v.id, "render")).toBe(1);
    expect(await nonces(v.id)).toEqual({});
  });
  describe("narration (tts) only with a free voice", () => {
    const route = (provider: string, voice = "v1") => db.ownerPool.query("insert into media_routes (kind, scope, provider, voice) values ('voice', 'default', $1, $2) on conflict (kind, scope) do update set provider = $1, voice = $2", [provider, voice]);
    const hashOf = async (id: string, name: string) => (await db.pool.query("select input_hash from stage_runs where video_id=$1 and name=$2 order by created_at desc, id desc limit 1", [id, name])).rows[0].input_hash as string;
    it("re-runs with a free voice: new hash, audited, double click refused", async () => {
      await route("voicestudio");
      const v = await mk();
      await seed(v);
      const before = await hashOf(v.id, "tts");
      const r = await forceRerunStageById(db.pool, queue, actor, v.id, "tts");
      expect(r.ok).toBe(true);
      expect(await count(v.id, "tts")).toBe(2);
      expect(await hashOf(v.id, "tts")).not.toBe(before);
      expect(Object.keys(await nonces(v.id))).toEqual(["tts"]);
      expect((await db.pool.query("select count(*)::int as n from audit_log where event='stage.force_rerun_requested'")).rows[0].n).toBe(1);
      expect((await forceRerunStageById(db.pool, queue, actor, v.id, "tts")).ok).toBe(false);
      expect(await count(v.id, "tts")).toBe(2);
    });
    it("refuses a paid voice with a plain sentence and leaves nonces alone", async () => {
      await route("elevenlabs", "abc");
      const v = await mk();
      await seed(v);
      const r = await forceRerunStageById(db.pool, queue, actor, v.id, "tts");
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/paid \(elevenlabs\)/);
      expect(await count(v.id, "tts")).toBe(1);
      expect(await nonces(v.id)).toEqual({});
    });
    it("local_openai: allowed on a loopback address, refused on a remote one", async () => {
      await route("local_openai");
      await db.ownerPool.query("insert into settings (key, value, updated_by) values ('voice.local_url', to_jsonb($1::text), 'system') on conflict (key) do update set value = excluded.value", ["https://api.example.com"]);
      const v = await mk();
      await seed(v);
      const r = await forceRerunStageById(db.pool, queue, actor, v.id, "tts");
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/paid \(local_openai\)/);
      expect(await nonces(v.id)).toEqual({});
      await db.ownerPool.query("insert into settings (key, value, updated_by) values ('voice.local_url', to_jsonb($1::text), 'system') on conflict (key) do update set value = excluded.value", ["http://127.0.0.1:8880"]);
      expect((await forceRerunStageById(db.pool, queue, actor, v.id, "tts")).ok).toBe(true);
      const a = (await db.pool.query("select detail from audit_log where event='stage.force_rerun_requested'")).rows[0].detail;
      expect(a).toMatchObject({ voiceProvider: "local_openai", voiceName: "v1" });
    });
    it("refuses when no voice route exists", async () => {
      const v = await mk();
      await seed(v);
      const r = await forceRerunStageById(db.pool, queue, actor, v.id, "tts");
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/No narration voice/);
      expect(await nonces(v.id)).toEqual({});
    });
    it("still applies the common checks (earlier step stale, upload)", async () => {
      await route("edge");
      const v = await mk();
      await seed(v, ["draft", "build", "tts"], { build: "failed" });
      expect((await forceRerunStageById(db.pool, queue, actor, v.id, "tts")).ok).toBe(false);
      const w = await mk("up");
      await seed(w, ["draft", "build", "tts"]);
      await db.pool.query("insert into uploads (id, video_id, status, approval_hash, file_sha) values ($1,$2,'publish_approved','a','b')", [uuidv7(), w.id]);
      expect((await forceRerunStageById(db.pool, queue, actor, w.id, "tts")).ok).toBe(false);
      expect(await nonces(v.id)).toEqual({});
      expect(await nonces(w.id)).toEqual({});
    });
    it("the page shows the stored voice and flags a changed setting", async () => {
      await route("edge", "en-US-A");
      const v = await mk();
      await addContent(db.pool, v.id, "narration", { body: { file: "narration.wav", voice_provider: "edge", voice_name: "en-US-A" }, sha256: sha256Hex("nv") });
      let p = await loadVideoPage(db.pool, v.id);
      expect(p!.voice).toMatchObject({ stored: { provider: "edge", voice: "en-US-A" }, current: { provider: "edge", voice: "en-US-A" } });
      await route("voicestudio", "x");
      p = await loadVideoPage(db.pool, v.id);
      expect(p!.voice.current).toEqual({ provider: "voicestudio", voice: "x" });
      const old = await mk("old"); // narration written before the voice fields existed
      await addContent(db.pool, old.id, "narration", { body: { file: "narration.wav", provider: "edge" }, sha256: sha256Hex("nv2") });
      expect((await loadVideoPage(db.pool, old.id))!.voice.stored).toBeNull();
    });
  });
});
