import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addContent } from "@/server/db/videos";
import { withTestDb, type TestDb } from "../support/db";

// Montage (M3, migration 0096): the database accepts a `montage` video and `footage` content, and still refuses an unknown kind.
let db: TestDb;
beforeAll(async () => { db = await withTestDb(); });
afterAll(async () => { await db?.stop(); });

const insert = (kind: string) => db.pool.query("insert into videos (format, kind, language, topic) values ('short', $1, 'en', 'night trains') returning id", [kind]);

describe("montage kind", () => {
  it("accepts a montage video and footage content for it", async () => {
    const v = await insert("montage");
    const r = await addContent(db.pool, v.rows[0].id, "footage", { body: { picks: [] }, sha256: "a".repeat(64) });
    expect(r.version).toBe(1);
  });
  it("still refuses an unknown video kind", async () => {
    await expect(insert("bogus")).rejects.toThrow(/videos_kind_check/);
  });
});
