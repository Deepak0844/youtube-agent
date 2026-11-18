import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureScopeCopies, videoTemplate } from "@/server/db/budget-scopes";
import { withTestDb, type TestDb } from "../support/db";

// A montage video gets its own per-video cap copy (migration 0097). Before it, the first paid step failed with "budget caps are not set up".
let db: TestDb;
beforeAll(async () => { db = await withTestDb(); });
afterAll(async () => { await db?.stop(); });

describe("montage budget", () => {
  it("has a video:montage template, so a montage video's scope copy can be made", async () => {
    expect(videoTemplate("montage", "short")).toBe("video:montage");
    const scopes = await ensureScopeCopies(db.pool, [["video:abc", videoTemplate("montage", "short")]]);
    expect(scopes).toEqual(["video:abc"]);
    const cap = (await db.pool.query("select cap_micro_usd from budgets where scope = 'video:abc'")).rows[0].cap_micro_usd;
    expect(Number(cap)).toBe(5_000_000);
  });
});
