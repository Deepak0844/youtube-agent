import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearSeriesCast, getSeriesCast, getVideoCast, saveSeriesCast, setVideoCast } from "@/server/db/cartoon-cast";
import { createSeries, getSeries, planParts, startPart } from "@/server/db/series";
import { withTestDb, type TestDb } from "../support/db";

// A cartoon series keeps one cast. An episode takes a COPY when it starts and builds from the copy, so clearing the series cast while an episode is being built
// never changes that episode; the next NEW episode starts with no cast and makes a new one.

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
const cast = (name: string) => [{ name, role: "the customer", style: "cartoon_comic" as const, options: { skin: "#b07a52" } }];
const make = async () => {
  const r = await createSeries(db.pool, actor, { title: "UPI series", premise: "", channelId: null, language: "en", formats: "short", capMicroUsd: null, settings: { style: "cartoon_comic" } });
  if (!r.ok) throw new Error(r.message);
  await planParts(db.pool, r.id, [1, 2, 3, 4].map((n) => ({ title: `Episode ${n}`, oneLine: "" })));
  return r.id;
};
const start = async (seriesId: string, n: number) => {
  const r = await startPart(db.pool, queue, actor, seriesId, n);
  if (!r.ok) throw new Error(r.message);
  return r.videoId;
};

describe("series cast", () => {
  it("the first episode saves the cast to the series; later episodes start with a copy of it", async () => {
    const id = await make();
    const e1 = await start(id, 1);
    expect(await getVideoCast(db.pool, e1)).toBeNull();
    expect(await saveSeriesCast(db.pool, id, cast("Raju"))).toBe(true);
    const e2 = await start(id, 2);
    expect(await getVideoCast(db.pool, e2)).toEqual(cast("Raju"));
    // the style setting is still readable beside the cast
    expect((await getSeries(db.pool, id))!.settings).toMatchObject({ style: "cartoon_comic", cartoon: { cast: cast("Raju") } });
  });
  it("only the first writer's cast is kept", async () => {
    const id = await make();
    expect(await saveSeriesCast(db.pool, id, cast("Raju"))).toBe(true);
    expect(await saveSeriesCast(db.pool, id, cast("Other"))).toBe(false);
    expect(await getSeriesCast(db.pool, id)).toEqual(cast("Raju"));
  });
  it("clearing the cast while episode 3 is started leaves episode 3 its copy; episode 4 starts with none", async () => {
    const id = await make();
    await saveSeriesCast(db.pool, id, cast("Raju"));
    const e3 = await start(id, 3);
    await clearSeriesCast(db.pool, id);
    expect(await getSeriesCast(db.pool, id)).toBeNull();
    expect(await getVideoCast(db.pool, e3)).toEqual(cast("Raju"));
    const e4 = await start(id, 4);
    expect(await getVideoCast(db.pool, e4)).toBeNull();
    expect((await getSeries(db.pool, id))!.settings.style).toBe("cartoon_comic");
  });
  it("a bad stored value reads as no cast", async () => {
    const id = await make();
    const e1 = await start(id, 1);
    await db.ownerPool.query("update videos set cast_snapshot = '[{\"name\":1}]'::jsonb where id = $1", [e1]);
    expect(await getVideoCast(db.pool, e1)).toBeNull();
    await setVideoCast(db.pool, e1, cast("Meena"));
    expect(await getVideoCast(db.pool, e1)).toEqual(cast("Meena"));
  });
});
