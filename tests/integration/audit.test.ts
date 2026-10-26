import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { listAudit, recordAudit } from "@/server/db/audit";
import { withTestDb, type TestDb } from "../support/db";
import type { AuditEvent } from "@/server/core/audit-events";

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

const TOKEN = "Zx9_Qw3-Er5TyUi7OpAsDfGhJkLzXcVbNm12";
const rows = async () => (await db.ownerPool.query("select event, detail from audit_log order by id")).rows;

describe("recordAudit (runs on the app role)", () => {
  it("writes_with_only_insert_and_select_never_update_or_delete", async () => {
    expect((await db.pool.query("select current_user u")).rows[0].u).toBe("ytstudio_app");
    await recordAudit(db.pool, "setting.changed", { setting: "jobs.concurrent_jobs", from: 2, to: 3 });
    await recordAudit(db.pool, "vault.init");
    const page = await listAudit(db.pool, {});
    expect(page.rows).toHaveLength(2);
    // The role really is unable to rewrite history, so the writer cannot have relied on it.
    await expect(db.pool.query("update audit_log set event = 'x'")).rejects.toMatchObject({ code: "42501" });
    await expect(db.pool.query("delete from audit_log")).rejects.toMatchObject({ code: "42501" });
  });

  it("stores_no_secret_from_hostile_payloads", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await recordAudit(db.pool, "key.set", {
        name: "openai",
        apiKey: "sk-live-1234",
        password: "hunter2",
        totp_secret: "JBSWY3DPEHPK3PXP",
        recoveryCodes: ["abcd-efgh", "ijkl-mnop"],
        authorization: `Bearer ${TOKEN}`,
        nested: { cookie: "sid=1", url: `https://x.test/setup/${TOKEN}`, list: [TOKEN] },
        last4: "1234",
      });
    } finally {
      err.mockRestore();
    }
    const [r] = await rows();
    const flat = JSON.stringify(r.detail);
    for (const bad of ["sk-live", "hunter2", "JBSWY3", "abcd-efgh", "ijkl", TOKEN, "sid=1"]) expect(flat).not.toContain(bad);
    expect(r.detail.name).toBe("openai");
    expect(r.detail.last4).toBe("1234");
  });

  it("reports_only_key_names_of_redactions_never_values", async () => {
    const lines: string[] = [];
    const err = vi.spyOn(console, "error").mockImplementation((s) => void lines.push(String(s)));
    try {
      await recordAudit(db.pool, "key.set", { password: "hunter2", note: TOKEN });
    } finally {
      err.mockRestore();
    }
    expect(lines.join("\n")).not.toMatch(/hunter2|Zx9_/);
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ event: "audit.redacted", key: "password" }, { event: "audit.redacted", key: "note" }]);
  });

  it("refuses_unknown_event_at_runtime_and_writes_nothing", async () => {
    // @ts-expect-error unknown event names are a compile error
    await expect(recordAudit(db.pool, "made.up", {})).rejects.toThrow(/unknown audit event/);
    await expect(recordAudit(db.pool, "constructor" as AuditEvent, {})).rejects.toThrow(/unknown audit event/);
    expect(await rows()).toHaveLength(0);
  });
});

describe("listAudit keyset paging", () => {
  async function seed(n: number, event: AuditEvent = "setting.changed") {
    for (let i = 0; i < n; i++) await recordAudit(db.pool, event, { i });
  }

  it("pages_newest_first_without_gaps_or_repeats", async () => {
    await seed(7);
    const seen: string[] = [];
    let before: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const p = await listAudit(db.pool, { limit: 3, before });
      seen.push(...p.rows.map((r) => r.id));
      if (!p.next) break;
      before = p.next;
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(seen.map(Number)).toEqual([...seen.map(Number)].sort((a, b) => b - a));
  });

  it("is_stable_under_concurrent_inserts", async () => {
    await seed(6);
    const first = await listAudit(db.pool, { limit: 3 });
    await seed(4); // new rows land while the reader holds its cursor
    const second = await listAudit(db.pool, { limit: 3, before: first.next! });
    const ids = [...first.rows, ...second.rows].map((r) => r.id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
    expect(second.rows.every((r) => BigInt(r.id) < BigInt(first.rows.at(-1)!.id))).toBe(true);
    expect(second.next).toBeNull();
  });

  it("filters_by_event_prefix_literally", async () => {
    await seed(2, "key.set");
    await seed(1, "key.removed");
    await seed(3, "model.added");
    await recordAudit(db.pool, "google_app.saved");
    expect((await listAudit(db.pool, { eventPrefix: "key." })).rows).toHaveLength(3);
    expect((await listAudit(db.pool, { eventPrefix: "model" })).rows).toHaveLength(3);
    // LIKE wildcards must be literals, not patterns.
    expect((await listAudit(db.pool, { eventPrefix: "%" })).rows).toHaveLength(0);
    expect((await listAudit(db.pool, { eventPrefix: "_" })).rows).toHaveLength(0);
    expect((await listAudit(db.pool, { eventPrefix: "google_" })).rows).toHaveLength(1);
  });

  it("caps_the_limit_at_200_and_rejects_nonsense", async () => {
    await seed(3);
    expect((await listAudit(db.pool, { limit: 100000 })).rows).toHaveLength(3);
    const spy = vi.spyOn(db.pool, "query");
    await listAudit(db.pool, { limit: 100000 });
    expect(spy.mock.calls[0]![1]).toContain(201); // 200 + 1 look-ahead row
    spy.mockRestore();
    await expect(listAudit(db.pool, { limit: 0 })).rejects.toThrow(RangeError);
    await expect(listAudit(db.pool, { limit: 1.5 })).rejects.toThrow(RangeError);
    await expect(listAudit(db.pool, { before: "1; drop table audit_log" })).rejects.toThrow(RangeError);
  });

  it("listing_returns_redacted_detail_as_stored", async () => {
    await recordAudit(db.pool, "key.set", { name: "x", apiKey: "k" });
    expect((await listAudit(db.pool, {})).rows[0]!.detail).toEqual({ name: "x", apiKey: "[redacted]" });
  });
});
