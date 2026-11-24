import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addSceneNote, markSceneNoteUsed, unusedSceneNote } from "@/server/db/scene-notes";
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

const video = async () => (await createVideoRow(db.pool, { format: "short", kind: "tsx", language: "en", topic: "UPI", style: "cartoon_comic" })).id;

describe("scene notes", () => {
  it("keeps a note of 1 to 500 characters and refuses a 501-character one", async () => {
    const id = await video();
    expect(await addSceneNote(db.pool, id, "ending too plain")).toMatchObject({ ok: true });
    expect(await addSceneNote(db.pool, id, "x".repeat(501))).toMatchObject({ ok: false });
    expect(await addSceneNote(db.pool, id, "   ")).toMatchObject({ ok: false });
  });
  it("refuses a 4th note with a plain sentence", async () => {
    const id = await video();
    for (const n of ["one", "two", "three"]) expect(await addSceneNote(db.pool, id, n)).toMatchObject({ ok: true });
    expect(await addSceneNote(db.pool, id, "four")).toEqual({ ok: false, message: "This video already had 3 notes. Start a fresh scene instead." });
  });
  it("the build reads the oldest unused note once", async () => {
    const id = await video();
    await addSceneNote(db.pool, id, "first");
    await addSceneNote(db.pool, id, "second");
    const a = await unusedSceneNote(db.pool, id);
    expect(a?.note).toBe("first");
    await markSceneNoteUsed(db.pool, a!.id);
    expect((await unusedSceneNote(db.pool, id))?.note).toBe("second");
  });
});
