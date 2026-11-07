import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addIdea, dismissIdea, draftIdea, listIdeas } from "@/server/db/ideas";
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

const actor = { kind: "session", sessionId: "0190f3a2-7c1e-7a55-9d3b-2f6c8a1b4e91" } as const;
const queue = { enqueue: async (id: string, fence: number, seq: number) => `stage.${id}.${fence}.${seq}` };
const idea = (topic: string, o: Partial<{ hook: string; why: string; sources: string[]; score: number }> = {}) => ({ topic, hook: o.hook ?? "", why: o.why ?? "", sources: o.sources ?? [], score: o.score ?? 6 });

describe("addIdea", () => {
  it("stores the idea and audits it without the text", async () => {
    const r = await addIdea(db.pool, actor, idea("How a hash map works", { hook: "Lookup in one step", sources: ["https://example.com/a"] }));
    expect(r.ok).toBe(true);
    const [row] = await listIdeas(db.pool);
    expect(row).toMatchObject({ topic: "How a hash map works", hook: "Lookup in one step", sources: ["https://example.com/a"], score: 6, status: "proposed" });
    const { rows } = await db.ownerPool.query("select detail from audit_log where event = 'idea.added'");
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0].detail)).not.toContain("hash map");
  });
  it("rejects a topic too like an existing idea, even a dismissed one", async () => {
    const a = await addIdea(db.pool, actor, idea("Bloom filter explained"));
    if (!a.ok) throw new Error("setup");
    await dismissIdea(db.pool, actor, a.id);
    const r = await addIdea(db.pool, actor, idea("How does a bloom filter work"));
    expect(r).toMatchObject({ ok: false });
    expect(await listIdeas(db.pool)).toHaveLength(0);
  });
  it("rejects a topic too like an existing video topic", async () => {
    await createVideoRow(db.pool, { format: "short", kind: "scene_kit", language: "en", topic: "Binary search in 40 seconds" });
    const r = await addIdea(db.pool, actor, idea("binary search"));
    expect(r).toMatchObject({ ok: false });
  });
});

describe("dismissIdea", () => {
  it("hides a proposed idea and audits; a second dismiss changes nothing", async () => {
    const a = await addIdea(db.pool, actor, idea("How a hash map works"));
    if (!a.ok) throw new Error("setup");
    expect(await dismissIdea(db.pool, actor, a.id)).toEqual({ ok: true });
    expect(await listIdeas(db.pool)).toHaveLength(0);
    expect(await dismissIdea(db.pool, actor, a.id)).toMatchObject({ ok: false });
    const { rows } = await db.ownerPool.query("select 1 from audit_log where event = 'idea.dismissed'");
    expect(rows).toHaveLength(1);
  });
});

describe("listIdeas", () => {
  it("shows highest score first", async () => {
    await addIdea(db.pool, actor, idea("Quick sort in forty seconds", { score: 5 }));
    await addIdea(db.pool, actor, idea("How DNS looks up a name", { score: 9 }));
    expect((await listIdeas(db.pool)).map((i) => i.score)).toEqual([9, 5]);
  });
});

describe("draftIdea", () => {
  it("creates a normal video with the chosen kind, links it, and approves nothing", async () => {
    const a = await addIdea(db.pool, actor, idea("How a hash map works", { hook: "One step lookup", why: "Common interview question" }));
    if (!a.ok) throw new Error("setup");
    const r = await draftIdea(db.pool, queue, actor, a.id, { kind: "tsx", language: "hi" });
    if (!r.ok) throw new Error(r.message);
    const v = await db.ownerPool.query("select kind, language, topic, notes, format from videos where id = $1", [r.videoId]);
    expect(v.rows[0]).toMatchObject({ kind: "tsx", language: "hi", topic: "How a hash map works", format: "short" });
    expect(v.rows[0].notes).toContain("One step lookup");
    const [row] = await listIdeas(db.pool);
    expect(row).toMatchObject({ status: "drafted", videoId: r.videoId });
    expect((await db.ownerPool.query("select 1 from approvals")).rows).toHaveLength(0);
    expect((await db.ownerPool.query("select 1 from uploads")).rows).toHaveLength(0);
    expect((await db.ownerPool.query("select 1 from audit_log where event = 'idea.drafted'")).rows).toHaveLength(1);
  });
  it("a second Draft now on the same idea creates no second video", async () => {
    const a = await addIdea(db.pool, actor, idea("How a hash map works"));
    if (!a.ok) throw new Error("setup");
    await draftIdea(db.pool, queue, actor, a.id, { kind: "scene_kit", language: "en" });
    expect(await draftIdea(db.pool, queue, actor, a.id, { kind: "scene_kit", language: "en" })).toMatchObject({ ok: false });
    expect((await db.ownerPool.query("select 1 from videos")).rows).toHaveLength(1);
  });
  it("refuses a dismissed idea and a bad kind", async () => {
    const a = await addIdea(db.pool, actor, idea("How a hash map works"));
    if (!a.ok) throw new Error("setup");
    expect(await draftIdea(db.pool, queue, actor, a.id, { kind: "bogus", language: "en" })).toMatchObject({ ok: false });
    await dismissIdea(db.pool, actor, a.id);
    expect(await draftIdea(db.pool, queue, actor, a.id, { kind: "scene_kit", language: "en" })).toMatchObject({ ok: false });
    expect((await db.ownerPool.query("select 1 from videos")).rows).toHaveLength(0);
  });
});
