import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PAGE_SIZE, parseNewVideoForm, parseLibraryQuery } from "@/server/core/videos-view";
import { startNewVideo } from "@/server/db/video-create";
import { listVideos } from "@/server/db/videos-list";
import { createVideoRow } from "@/server/db/videos";
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
const mk = (topic: string, o: Partial<{ language: "en" | "hi"; status: string }> = {}) =>
  createVideoRow(db.pool, { format: "short", kind: "scene_kit", language: o.language ?? "en", topic }).then(async (v) => {
    if (o.status) await db.pool.query("update videos set status = $2 where id = $1", [v.id, o.status]);
    return v;
  });

describe("listVideos", () => {
  it("lists newest first and filters", async () => {
    const a = await mk("first");
    const b = await mk("second", { language: "hi", status: "waiting" });
    const c = await mk("third", { status: "done" });
    const all = await listVideos(db.pool, parseLibraryQuery({}));
    expect(all.rows.map((r) => r.id)).toEqual([c.id, b.id, a.id]);
    expect((await listVideos(db.pool, parseLibraryQuery({ language: "hi" }))).rows.map((r) => r.id)).toEqual([b.id]);
    expect((await listVideos(db.pool, parseLibraryQuery({ status: "done" }))).rows.map((r) => r.id)).toEqual([c.id]);
    expect((await listVideos(db.pool, parseLibraryQuery({ format: "long" }))).rows).toEqual([]);
    expect((await listVideos(db.pool, parseLibraryQuery({ kind: "tsx" }))).rows).toEqual([]);
  });

  it("adds up settled spend per video and reports the latest activity", async () => {
    const v = await mk("costly");
    const other = await mk("free");
    const sr = "0190f3a2-7c1e-7a55-9d3b-2f6c8a1b4e01";
    await db.pool.query("insert into stage_runs (id, video_id, name, input_hash) values ($1,$2,'script','h')", [sr, v.id]);
    const intent = (id: string, status: string, actual: number | null, idx: number) =>
      db.pool.query("insert into spend_intents (id, stage_run_id, step_index, tool_call_index, call_key, status, actual_micro_usd) values ($1,$2,0,$3,$4,$5,$6)", [id, sr, idx, `k${idx}`, status, actual]);
    await intent("0190f3a2-7c1e-7a55-9d3b-2f6c8a1b4e11", "done", 1_500_000, 0);
    await intent("0190f3a2-7c1e-7a55-9d3b-2f6c8a1b4e12", "done", 500_000, 1);
    await intent("0190f3a2-7c1e-7a55-9d3b-2f6c8a1b4e13", "pending", null, 2);
    const rows = (await listVideos(db.pool, parseLibraryQuery({}))).rows;
    expect(rows.find((r) => r.id === v.id)?.costMicroUsd).toBe(2_000_000);
    expect(rows.find((r) => r.id === other.id)?.costMicroUsd).toBe(0);
    expect(rows.find((r) => r.id === v.id)!.lastActivity.getTime()).toBeGreaterThanOrEqual(v.updatedAt.getTime());
  });

  it("pages by 25 without gaps or repeats", async () => {
    const ids: string[] = [];
    for (let i = 0; i < PAGE_SIZE + 3; i++) ids.push((await mk(`v${i}`)).id);
    const p1 = await listVideos(db.pool, parseLibraryQuery({}));
    const p2 = await listVideos(db.pool, parseLibraryQuery({ page: "2" }));
    expect(p1.rows).toHaveLength(PAGE_SIZE);
    expect(p1.hasNext).toBe(true);
    expect(p2.rows).toHaveLength(3);
    expect(p2.hasNext).toBe(false);
    expect([...p1.rows, ...p2.rows].map((r) => r.id)).toEqual([...ids].reverse());
  });
});

describe("startNewVideo (the createVideoAction data path)", () => {
  const input = (o: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(o)) f.set(k, v);
    return parseNewVideoForm(f);
  };

  it("creates the row with its language, audits it and starts the pipeline", async () => {
    const p = input({ topic: "Why is the sky blue?", language: "ta", notes: "calm tone" });
    if (!p.ok) throw new Error("form should parse");
    const r = await startNewVideo(db.pool, queue, actor, p.value);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = (await db.pool.query("select topic, language, kind, format, notes from videos where id = $1", [r.videoId])).rows[0];
    expect(v).toEqual({ topic: "Why is the sky blue?", language: "ta", kind: "scene_kit", format: "short", notes: "calm tone" });
    const runs = (await db.pool.query("select name, status from stage_runs where video_id = $1", [r.videoId])).rows;
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("queued");
    expect(queued).toHaveLength(1);
    const audit = (await db.pool.query("select detail from audit_log where event = 'video.created'")).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].detail).toMatchObject({ videoId: r.videoId, language: "ta", sessionId: SESSION });
    expect(JSON.stringify(audit[0].detail)).not.toContain("sky");
  });

  it("invalid input is refused before anything is written", async () => {
    for (const bad of [{ topic: "", language: "en" }, { topic: "x".repeat(201), language: "en" }, { topic: "x", language: "xx" }]) expect(input(bad).ok).toBe(false);
    expect((await db.pool.query("select count(*)::int as n from videos")).rows[0].n).toBe(0);
    expect((await db.pool.query("select count(*)::int as n from audit_log where event = 'video.created'")).rows[0].n).toBe(0);
  });

  it("a non-owner actor creates nothing", async () => {
    const r = await startNewVideo(db.pool, queue, { kind: "session", sessionId: "nope" }, { topic: "x", language: "en", kind: "scene_kit", format: "short" });
    expect(r.ok).toBe(false);
    expect((await db.pool.query("select count(*)::int as n from videos")).rows[0].n).toBe(0);
  });
});
