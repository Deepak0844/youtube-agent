import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadCalendar } from "@/server/db/calendar-data";
import { listTitleTests } from "@/server/db/title-tests-list";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
beforeAll(async () => { db = await withTestDb(); });
afterAll(async () => { await db?.stop(); });
beforeEach(async () => { await db.reset(); });

describe("loadCalendar", () => {
  it("on_an_empty_database_returns_empty_lists_and_defaults", async () => {
    const d = await loadCalendar(db.pool);
    expect(d.settings.enabled).toBe(false);
    expect(d.runs).toEqual([]);
    expect(d.lastDrafting).toBeNull();
    expect(d.waiting).toBe(0);
    expect(d.ideas).toEqual([]);
    expect(d.queue).toEqual([]);
    expect(d.uploaded).toEqual([]);
  });

  it("shows_top_10_proposed_ideas_by_score_and_the_latest_drafting_run", async () => {
    for (let i = 0; i < 12; i++) await db.ownerPool.query("insert into ideas (topic, score) values ($1, $2)", [`Topic number ${i}`, 2 + i * 0.5]);
    await db.ownerPool.query("insert into ideas (topic, score, status) values ('Dismissed one', 10, 'dismissed')");
    await db.ownerPool.query("insert into schedule_runs (job, run_key, status, message) values ('drafting', '2026-11-07', 'ok', '1 started, 0 failed, 0 skipped as duplicates; no more usable ideas')");
    const d = await loadCalendar(db.pool);
    expect(d.ideas).toHaveLength(10);
    expect(d.ideas[0]!.topic).toBe("Topic number 11");
    expect(d.lastDrafting?.runKey).toBe("2026-11-07");
    expect(d.runs).toHaveLength(1);
  });
});

describe("listTitleTests", () => {
  it("is_empty_without_tests", async () => {
    expect(await listTitleTests(db.pool)).toEqual([]);
  });
});
