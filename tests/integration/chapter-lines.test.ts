import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadChapterLines } from "@/server/db/upload-details";
import { createVideoRow } from "@/server/db/videos";
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

const chapters = [{ title: "Hook", startMs: 0 }, { title: "How it works", startMs: 100_000 }, { title: "Why", startMs: 250_000 }];
const render = (videoId: string, result: unknown, status = "succeeded") =>
  db.pool.query("insert into stage_runs (id, video_id, name, status, input_hash, result) values (gen_random_uuid(), $1, 'render', $2, 'x', $3::jsonb)", [videoId, status, JSON.stringify(result)]);
const long = () => createVideoRow(db.pool, { format: "long", kind: "scene_kit", language: "en", topic: "sea", lengthMinMinutes: 3, lengthMaxMinutes: 8 });

describe("loadChapterLines", () => {
  it("gives the YouTube chapter lines from the render result of a long video", async () => {
    const v = await long();
    await render(v.id, { rendered: "render.mp4", chapters, chaptersFrom: "scenes", totalMs: 360_000 });
    expect(await loadChapterLines(db.pool, v.id)).toBe("0:00 Hook\n1:40 How it works\n4:10 Why");
  });
  it("gives nothing before a render, for a failed render, or when the chapters are too short for YouTube", async () => {
    const v = await long();
    expect(await loadChapterLines(db.pool, v.id)).toBeNull();
    await render(v.id, { chapters, totalMs: 360_000 }, "failed");
    expect(await loadChapterLines(db.pool, v.id)).toBeNull();
    const w = await long();
    await render(w.id, { chapters, totalMs: 255_000 }); // last chapter 5 s
    expect(await loadChapterLines(db.pool, w.id)).toBeNull();
  });
  it("gives nothing for a short video, even if a result has chapters", async () => {
    const s = await createVideoRow(db.pool, { format: "short", kind: "scene_kit", language: "en", topic: "sea" });
    await render(s.id, { chapters, totalMs: 360_000 });
    expect(await loadChapterLines(db.pool, s.id)).toBeNull();
  });
});
