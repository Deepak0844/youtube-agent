import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@/server/core/content-hash";
import { addContent, createVideoRow, latestContent } from "@/server/db/videos";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
beforeAll(async () => {
  db = await withTestDb();
});
beforeEach(async () => {
  await db.reset();
});
afterAll(async () => {
  await db?.stop();
});

describe("thumbnail content kind", () => {
  it("is saved as a content version of a long video and read back", async () => {
    const v = await createVideoRow(db.pool, { format: "long", kind: "collage", language: "en", topic: "sea", lengthMinMinutes: 3, lengthMaxMinutes: 8 });
    await addContent(db.pool, v.id, "thumbnail", { filePath: `videos/${v.id}/thumbnail.png`, sha256: sha256Hex("png-1") });
    await addContent(db.pool, v.id, "thumbnail", { filePath: `videos/${v.id}/thumbnail.png`, sha256: sha256Hex("png-2") });
    const c = await latestContent(db.pool, v.id, "thumbnail");
    expect(c?.version).toBe(2);
    expect(c?.sha256).toBe(sha256Hex("png-2"));
  });
  it("the database still refuses a kind it does not know", async () => {
    const v = await createVideoRow(db.pool, { format: "short", kind: "collage", language: "en", topic: "sea" });
    await expect(db.pool.query("insert into video_content (video_id, kind, version, sha256, body) values ($1, 'thumbnails', 1, 'x', '{}'::jsonb)", [v.id])).rejects.toThrow(/video_content_kind_check/);
  });
});
