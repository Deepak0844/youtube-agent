import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { searchVideoTitles } from "@/server/db/videos-list";
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
const mk = (topic: string) => createVideoRow(db.pool, { format: "short", kind: "collage", language: "en", topic });

describe("searchVideoTitles (⌘K jump-to)", () => {
  it("matches titles case-insensitively, newest first", async () => {
    const a = await mk("Gold price explained");
    const b = await mk("golden hour tips");
    await mk("UPI tricks");
    expect((await searchVideoTitles(db.pool, "GOLD")).map((r) => r.id)).toEqual([b.id, a.id]);
  });
  it("treats % and _ literally", async () => {
    const a = await mk("Gold 100% guide");
    await mk("Golden hour");
    expect((await searchVideoTitles(db.pool, "100%")).map((r) => r.id)).toEqual([a.id]);
    expect(await searchVideoTitles(db.pool, "_")).toEqual([]);
  });
  it("blank input finds nothing; the limit holds", async () => {
    for (let i = 0; i < 10; i++) await mk(`clip ${i}`);
    expect(await searchVideoTitles(db.pool, "   ")).toEqual([]);
    expect((await searchVideoTitles(db.pool, "clip")).length).toBe(8);
  });
});
