import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTestDb, type TestDb } from "../support/db";
import { addContent, createVideoRow, latestContent } from "@/server/db/videos";

let db: TestDb;
beforeAll(async () => {
  db = await withTestDb();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.ownerPool.query("truncate videos, video_content cascade");
});

const input = { format: "short", kind: "scene_kit", language: "en", topic: "Why the sky is blue" } as const;
const h = (c: string) => c.repeat(64).slice(0, 64);

describe("videos", () => {
  it("creates_a_video_as_the_app_role_with_defaults", async () => {
    const v = await createVideoRow(db.pool, input);
    expect(v).toMatchObject({ format: "short", status: "active", channelId: null, notes: null });
    expect((await db.pool.query("select current_user u")).rows[0].u).toBe("ytstudio_app");
  });
  it("rejects_bad_enums", async () => {
    await expect(createVideoRow(db.pool, { ...input, language: "xx" as never })).rejects.toThrow();
    await expect(db.pool.query("insert into videos (format, kind, language, topic, status) values ('short','ai','en','t','weird')")).rejects.toThrow();
  });
  it("latest_content_is_null_before_any_add", async () => {
    const v = await createVideoRow(db.pool, input);
    expect(await latestContent(db.pool, v.id, "script")).toBeNull();
  });
  it("versions_increment_per_kind_and_latest_returns_newest", async () => {
    const v = await createVideoRow(db.pool, input);
    expect(await addContent(db.pool, v.id, "script", { body: { n: 1 }, sha256: h("a") })).toEqual({ version: 1 });
    expect(await addContent(db.pool, v.id, "script", { body: { n: 2 }, sha256: h("b") })).toEqual({ version: 2 });
    expect(await addContent(db.pool, v.id, "beats", { body: [], sha256: h("c") })).toEqual({ version: 1 });
    expect(await latestContent(db.pool, v.id, "script")).toMatchObject({ version: 2, sha256: h("b"), body: { n: 2 } });
  });
  it("latest_content_version_increments_and_is_unique_under_20_concurrent_adds", async () => {
    const v = await createVideoRow(db.pool, input);
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => addContent(db.pool, v.id, "script", { body: { i }, sha256: h("d") })));
    expect(rs.map((r) => r.version).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });
  it("body_size_check_forces_large_bodies_into_files", async () => {
    const v = await createVideoRow(db.pool, input);
    const big = { t: "x".repeat(300 * 1024) };
    await expect(addContent(db.pool, v.id, "script", { body: big, sha256: h("e") })).rejects.toThrow();
    await expect(db.pool.query("insert into video_content (video_id, kind, version, sha256, body) values ($1,'script',9,$2,$3)", [v.id, h("e"), JSON.stringify(big)])).rejects.toThrow(/video_content_body_size|check/);
    expect(await addContent(db.pool, v.id, "video", { filePath: "videos/x/out.mp4", sha256: h("f") })).toEqual({ version: 1 });
  });
  it("needs_exactly_one_of_body_or_file_and_a_valid_hash", async () => {
    const v = await createVideoRow(db.pool, input);
    await expect(addContent(db.pool, v.id, "script", { sha256: h("a") } as never)).rejects.toThrow();
    await expect(addContent(db.pool, v.id, "script", { body: {}, filePath: "x", sha256: h("a") } as never)).rejects.toThrow();
    await expect(addContent(db.pool, v.id, "script", { body: {}, sha256: "nothex" })).rejects.toThrow();
  });
});
