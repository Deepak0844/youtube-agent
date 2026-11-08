import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSeries, dropPart, getSeries, listSeries, movePart, planParts, startPart } from "@/server/db/series";
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

const actor = { kind: "session", sessionId: "0190f3a2-7c1e-7a55-9d3b-2f6c8a1b4e91" } as const;
const queue = { enqueue: async (id: string, fence: number, seq: number) => `stage.${id}.${fence}.${seq}` };
const input = (o: Partial<{ title: string; capMicroUsd: number | null; formats: "short" | "long" | "mixed"; channelId: string | null }> = {}) => ({
  title: o.title ?? "Data structures", premise: "Short lessons", channelId: o.channelId ?? null, language: "hi" as const, formats: o.formats ?? ("short" as const), capMicroUsd: o.capMicroUsd ?? null, settings: { style: "flat_motion" as const },
});
const make = async (o: Parameters<typeof input>[0] = {}) => {
  const r = await createSeries(db.pool, actor, input(o));
  if (!r.ok) throw new Error(r.message);
  return r.id;
};
const episodes = [{ title: "Arrays", oneLine: "Memory layout" }, { title: "Hash maps", oneLine: "" }, { title: "Trees", oneLine: "" }];

describe("createSeries", () => {
  it("stores the series and audits it without text", async () => {
    const id = await make({ title: "Secret premise series" });
    const s = await getSeries(db.pool, id);
    expect(s).toMatchObject({ title: "Secret premise series", language: "hi", formats: "short", capMicroUsd: null, settings: { style: "flat_motion" } });
    expect(await listSeries(db.pool)).toHaveLength(1);
    const { rows } = await db.ownerPool.query("select detail from audit_log where event = 'series.created'");
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0].detail)).not.toContain("Secret");
  });
  it("refuses a channel that is not connected", async () => {
    expect(await createSeries(db.pool, actor, input({ channelId: "UCnope" }))).toMatchObject({ ok: false });
  });
});

describe("planParts", () => {
  it("numbers parts from 1, appends later ones after the highest, and counts them", async () => {
    const id = await make();
    await planParts(db.pool, id, episodes);
    await planParts(db.pool, id, [{ title: "Graphs", oneLine: "" }]);
    const s = (await getSeries(db.pool, id))!;
    expect(s.parts.map((p) => [p.partNo, p.title, p.status])).toEqual([[1, "Arrays", "planned"], [2, "Hash maps", "planned"], [3, "Trees", "planned"], [4, "Graphs", "planned"]]);
    expect(s.partsPlanned).toBe(4);
  });
  it("does not reuse the number of a dropped part", async () => {
    const id = await make();
    await planParts(db.pool, id, episodes);
    await dropPart(db.pool, id, 3);
    await planParts(db.pool, id, [{ title: "Graphs", oneLine: "" }]);
    const s = (await getSeries(db.pool, id))!;
    expect(s.parts.map((p) => [p.partNo, p.status])).toEqual([[1, "planned"], [2, "planned"], [3, "dropped"], [4, "planned"]]);
    expect(s.partsPlanned).toBe(3);
  });
});

describe("movePart and dropPart", () => {
  it("swaps a planned part with its planned neighbour; the end does nothing", async () => {
    const id = await make();
    await planParts(db.pool, id, episodes);
    expect(await movePart(db.pool, id, 2, "up")).toEqual({ ok: true });
    expect((await getSeries(db.pool, id))!.parts.map((p) => p.title)).toEqual(["Hash maps", "Arrays", "Trees"]);
    expect(await movePart(db.pool, id, 1, "up")).toMatchObject({ ok: false });
  });
  it("drops only a planned part", async () => {
    const id = await make();
    await planParts(db.pool, id, episodes);
    expect(await dropPart(db.pool, id, 2)).toEqual({ ok: true });
    expect(await dropPart(db.pool, id, 2)).toMatchObject({ ok: false });
  });
});

describe("startPart", () => {
  it("makes a normal draft with the series link, channel language and style, and approves nothing", async () => {
    const id = await make();
    await planParts(db.pool, id, episodes);
    const r = await startPart(db.pool, queue, actor, id, 2);
    if (!r.ok) throw new Error(r.message);
    const v = await db.ownerPool.query("select topic, language, format, style, series_id, part_no from videos where id = $1", [r.videoId]);
    expect(v.rows[0]).toMatchObject({ topic: "Hash maps", language: "hi", format: "short", style: "flat_motion", series_id: id, part_no: 2 });
    const part = (await getSeries(db.pool, id))!.parts.find((p) => p.partNo === 2)!;
    expect(part).toMatchObject({ status: "started", videoId: r.videoId });
    expect((await db.ownerPool.query("select 1 from approvals")).rows).toHaveLength(0);
    expect((await db.ownerPool.query("select 1 from uploads")).rows).toHaveLength(0);
    const a = await db.ownerPool.query("select detail from audit_log where event = 'series.part_started'");
    expect(a.rows).toHaveLength(1);
    expect(JSON.stringify(a.rows[0].detail)).not.toContain("Hash");
  });
  it("a second start of the same part makes no second video; started parts cannot move or drop", async () => {
    const id = await make();
    await planParts(db.pool, id, episodes);
    await startPart(db.pool, queue, actor, id, 1);
    expect(await startPart(db.pool, queue, actor, id, 1)).toMatchObject({ ok: false });
    expect((await db.ownerPool.query("select 1 from videos")).rows).toHaveLength(1);
    expect(await dropPart(db.pool, id, 1)).toMatchObject({ ok: false });
    expect(await movePart(db.pool, id, 1, "down")).toMatchObject({ ok: false });
  });
  it("a long part waits for long-form support and creates nothing", async () => {
    const id = await make({ formats: "long" });
    await planParts(db.pool, id, episodes);
    expect(await startPart(db.pool, queue, actor, id, 1)).toMatchObject({ ok: false });
    expect((await db.ownerPool.query("select 1 from videos")).rows).toHaveLength(0);
    expect((await getSeries(db.pool, id))!.parts[0]!.status).toBe("planned");
  });
  it("refuses once the series spend has reached its cap", async () => {
    const id = await make({ capMicroUsd: 1000 });
    await planParts(db.pool, id, episodes);
    const first = await startPart(db.pool, queue, actor, id, 1);
    if (!first.ok) throw new Error(first.message);
    const sr = (await db.ownerPool.query("select id from stage_runs where video_id = $1 limit 1", [first.videoId])).rows[0].id;
    await db.ownerPool.query("insert into spend_intents (id, stage_run_id, step_index, tool_call_index, call_key, status, actual_micro_usd) values (gen_random_uuid(), $1, 0, 0, 'k-series', 'done', 1500)", [sr]);
    const s = (await getSeries(db.pool, id))!;
    expect(s).toMatchObject({ spentMicroUsd: 1500, cap: { state: "over" } });
    expect(await startPart(db.pool, queue, actor, id, 2)).toMatchObject({ ok: false });
    expect((await db.ownerPool.query("select 1 from videos")).rows).toHaveLength(1);
    expect((await listSeries(db.pool))[0]).toMatchObject({ spentMicroUsd: 1500 });
  });
});
