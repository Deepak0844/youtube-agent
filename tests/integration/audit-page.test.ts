import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AUDIT_FILTERS, filterPrefix, parseAuditQuery } from "@/server/core/audit-view";
import { listAudit, type AuditRow } from "@/server/db/audit";
import { withTestDb, type TestDb } from "../support/db";

// The audit page's data path on the real app role: what the page asks listAudit for, from a URL it does not trust.
let db: TestDb;
beforeAll(async () => {
  db = await withTestDb();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.ownerPool.query("truncate audit_log restart identity");
});

const EVENTS = ["login.success", "key.set", "setting.changed", "login.failure", "model.added"];
async function seed(n: number) {
  for (let i = 0; i < n; i++) {
    await db.ownerPool.query("insert into audit_log (event, detail) values ($1, $2::jsonb)", [EVENTS[i % EVENTS.length], JSON.stringify({ n: i })]);
  }
}

/** Walks the pages exactly as the page does: each Older link carries the previous page's `next`. */
async function walk(raw: { event?: string }, limit: number): Promise<AuditRow[]> {
  const all: AuditRow[] = [];
  let before: string | null = null;
  for (let guard = 0; guard < 50; guard++) {
    const q = parseAuditQuery({ ...raw, ...(before ? { before } : {}) });
    const page = await listAudit(db.pool, { limit, ...(q.before ? { before: q.before } : {}), eventPrefix: filterPrefix(q.filter) });
    all.push(...page.rows);
    if (!page.next) return all;
    before = page.next;
  }
  throw new Error("paging did not end");
}

describe("audit page data path (app role)", () => {
  it("runs_on_the_app_role", async () => {
    expect((await db.pool.query("select current_user u")).rows[0].u).toBe("ytstudio_app");
  });

  it("pages_newest_first_with_no_gaps_or_duplicates", async () => {
    await seed(23);
    const rows = await walk({}, 5);
    expect(rows).toHaveLength(23);
    expect(rows.map((r) => Number(r.id))).toEqual(Array.from({ length: 23 }, (_, i) => 23 - i));
  });

  it("a_row_written_between_pages_never_shifts_an_older_page", async () => {
    await seed(12);
    const p1 = await listAudit(db.pool, { limit: 5 });
    await seed(3); // newer rows arrive while the owner is reading
    const p2 = await listAudit(db.pool, { limit: 5, before: p1.next! });
    expect(p2.rows.map((r) => Number(r.id))).toEqual([7, 6, 5, 4, 3]);
  });

  it("each_filter_chip_returns_only_its_family_and_all_of_it", async () => {
    await seed(25);
    for (const f of AUDIT_FILTERS) {
      const rows = await walk({ event: f.id }, 4);
      const expected = (await db.ownerPool.query("select id::text as i from audit_log where event like $1 order by id desc", [`${f.id}.%`])).rows.map((r) => r.i);
      expect(rows.map((r) => r.id), f.id).toEqual(expected);
      for (const r of rows) expect(r.event.startsWith(`${f.id}.`)).toBe(true);
    }
  });

  it("hostile_query_values_fall_back_to_the_newest_page_and_never_reach_sql", async () => {
    await seed(7);
    for (const before of ["1; drop table audit_log", "-1", "0", "9".repeat(40), "1e3", "' or 1=1 --", "%"]) {
      for (const event of ["%", "_", "' or 1=1 --", "login%", "__proto__"]) {
        const q = parseAuditQuery({ before, event });
        expect(q.before).toBeNull();
        expect(q.filter).toBeNull();
        const page = await listAudit(db.pool, { limit: 50, eventPrefix: filterPrefix(q.filter) });
        expect(page.rows).toHaveLength(7);
      }
    }
    expect((await db.pool.query("select count(*)::int n from audit_log")).rows[0].n).toBe(7);
  });

  it("an_empty_log_gives_an_empty_page_and_no_next", async () => {
    expect(await listAudit(db.pool, {})).toEqual({ rows: [], next: null });
  });

  it("a_cursor_past_the_oldest_row_is_an_empty_last_page", async () => {
    await seed(3);
    expect(await listAudit(db.pool, { before: "1" })).toEqual({ rows: [], next: null });
  });
});
