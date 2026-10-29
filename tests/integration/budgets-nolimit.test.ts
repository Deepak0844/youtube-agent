import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claimStage, insertQueuedStage, type Claim } from "@/server/db/stages";
import { getBudget, reserveIntent, settleIntent } from "@/server/db/spend";
import { ensureScopeCopies, listBudgetTemplates, setBudgetCap } from "@/server/db/budget-scopes";
import { BUDGET_DEFAULTS } from "@/server/core/settings-registry";
import { scopeHeadroom } from "@/worker/stages/deps";
import { uuidv7 } from "@/server/core/ids";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
beforeAll(async () => {
  db = await withTestDb();
});
beforeEach(async () => {
  await db.reset();
  for (const [scope, cap] of Object.entries(BUDGET_DEFAULTS)) {
    await db.pool.query("insert into budgets (scope, cap_micro_usd) values ($1, $2)", [scope, cap]);
  }
});
afterAll(async () => {
  await db?.stop();
});

async function claimed(): Promise<Claim> {
  const id = await insertQueuedStage(db.pool, { videoId: uuidv7(), name: "script", inputHash: "h" });
  const c = await claimStage(db.pool, { id, inputHash: "h", workerId: "w1", ttlMs: 60_000 });
  if (!c) throw new Error("claim failed");
  return c;
}
const setCapNull = (scope: string) => db.ownerPool.query("update budgets set cap_micro_usd = null where scope = $1", [scope]);
const capOf = async (scope: string) => (await db.pool.query<{ c: string | null }>("select cap_micro_usd as c from budgets where scope = $1", [scope])).rows[0]!.c;

describe("no-limit caps", () => {
  it("reserve_under_no_limit_cap_succeeds_and_is_recorded", async () => {
    await db.ownerPool.query("insert into budgets (scope, cap_micro_usd) values ('nl', null)");
    const c = await claimed();
    const r = await reserveIntent(db.pool, c, { stepIndex: 0, toolCallIndex: 0, reserveMicroUsd: 5_000_000_000, budgetScopes: ["nl"] });
    expect(r.kind).toBe("new");
    expect(await getBudget(db.pool, "nl")).toMatchObject({ capMicroUsd: null, reservedMicroUsd: 5_000_000_000 });
    if (r.kind !== "new") throw new Error("unreachable");
    await settleIntent(db.pool, r.intentId, { actualMicroUsd: 4_000_000_000, result: { ok: true } });
    expect(await getBudget(db.pool, "nl")).toMatchObject({ capMicroUsd: null, reservedMicroUsd: 0, spentMicroUsd: 4_000_000_000 });
  });

  it("no_limit_is_not_zero: a cap of 0 refuses a reservation and reserves nothing", async () => {
    await db.pool.query("insert into budgets (scope, cap_micro_usd) values ('zero', 0)");
    const c = await claimed();
    const r = await reserveIntent(db.pool, c, { stepIndex: 0, toolCallIndex: 0, reserveMicroUsd: 1, budgetScopes: ["zero"] });
    expect(r).toEqual({ kind: "refused", reason: "cap" });
    expect((await getBudget(db.pool, "zero"))!.reservedMicroUsd).toBe(0);
  });

  it("a missing budget row still refuses (fail closed)", async () => {
    const c = await claimed();
    const r = await reserveIntent(db.pool, c, { stepIndex: 0, toolCallIndex: 0, reserveMicroUsd: 1, budgetScopes: ["nope"] });
    expect(r).toEqual({ kind: "refused", reason: "cap" });
  });

  it("no_limit_copy_stays_no_limit_for_day_and_month", async () => {
    await setCapNull("day");
    await setCapNull("month");
    await ensureScopeCopies(db.pool, [["day:2030-01-01", "day"], ["month:2030-01", "month"]]);
    expect(await capOf("day:2030-01-01")).toBeNull();
    expect(await capOf("month:2030-01")).toBeNull();
    // asking again changes nothing
    await ensureScopeCopies(db.pool, [["day:2030-01-01", "day"], ["month:2030-01", "month"]]);
    expect(await capOf("day:2030-01-01")).toBeNull();
  });

  it("lowering_a_template_still_lowers_existing_copies", async () => {
    await ensureScopeCopies(db.pool, [["day:2030-01-01", "day"]]);
    expect(await capOf("day:2030-01-01")).toBe("15000000");
    await db.ownerPool.query("update budgets set cap_micro_usd = 1000000 where scope = 'day'");
    await ensureScopeCopies(db.pool, [["day:2030-01-01", "day"]]);
    expect(await capOf("day:2030-01-01")).toBe("1000000");
  });

  it("a no-limit copy is lowered when the template later gets a figure", async () => {
    await setCapNull("day");
    await ensureScopeCopies(db.pool, [["day:2030-01-01", "day"]]);
    await db.ownerPool.query("update budgets set cap_micro_usd = 2000000 where scope = 'day'");
    await ensureScopeCopies(db.pool, [["day:2030-01-01", "day"]]);
    expect(await capOf("day:2030-01-01")).toBe("2000000");
  });

  it("raising a template does not raise a copy that already exists", async () => {
    await ensureScopeCopies(db.pool, [["day:2030-01-01", "day"]]);
    await db.ownerPool.query("update budgets set cap_micro_usd = 99000000 where scope = 'day'");
    await ensureScopeCopies(db.pool, [["day:2030-01-01", "day"]]);
    expect(await capOf("day:2030-01-01")).toBe("15000000");
  });
});

describe("callers of a null cap", () => {
  it("scopeHeadroom treats no limit as unlimited room, never zero", async () => {
    await setCapNull("day");
    expect((await scopeHeadroom(db.pool, ["day"])).micro).toBe(Number.MAX_SAFE_INTEGER);
    await db.pool.query("insert into budgets (scope, cap_micro_usd) values ('zero', 0)");
    expect((await scopeHeadroom(db.pool, ["day", "zero"]))).toEqual({ micro: 0, scope: "zero" });
  });
});

describe("setBudgetCap", () => {
  it("sets a figure and no limit, with one audit row each carrying old and new", async () => {
    await setBudgetCap(db.pool, "video:ai", 20_000_000, "session");
    expect(await capOf("video:ai")).toBe("20000000");
    await setBudgetCap(db.pool, "video:ai", null, "session");
    expect(await capOf("video:ai")).toBeNull();
    await setBudgetCap(db.pool, "video:ai", 0, "session");
    expect(await capOf("video:ai")).toBe("0");
    const { rows } = await db.ownerPool.query<{ detail: Record<string, unknown> }>(
      "select detail from audit_log where event = 'budget.cap_changed' order by id",
    );
    expect(rows.map((r) => r.detail)).toEqual([
      { scope: "video:ai", oldCapMicroUsd: 15_000_000, newCapMicroUsd: 20_000_000 },
      { scope: "video:ai", oldCapMicroUsd: 20_000_000, newCapMicroUsd: null },
      { scope: "video:ai", oldCapMicroUsd: null, newCapMicroUsd: 0 },
    ]);
  });

  it.each([[-1], [1.5], [1e13], [1e12 + 1], [Number.NaN], [Infinity], [Number.MAX_SAFE_INTEGER + 1]])(
    "negative_or_float_or_1e13_cap_rejected (%s)",
    async (bad) => {
      await expect(setBudgetCap(db.pool, "day", bad, "session")).rejects.toThrow(RangeError);
      expect(await capOf("day")).toBe("15000000");
      expect((await db.ownerPool.query("select 1 from audit_log where event = 'budget.cap_changed'")).rowCount).toBe(0);
    },
  );

  it("accepts the 1e12 edge", async () => {
    await setBudgetCap(db.pool, "day", 1e12, "session");
    expect(await capOf("day")).toBe("1000000000000");
  });

  it("setBudgetCap_unknown_scope_rejected (not a template, not a copy)", async () => {
    await db.pool.query("insert into budgets (scope, cap_micro_usd) values ('day:2030-01-01', 5)");
    for (const scope of ["nope", "day:2030-01-01", "", "video:abc"]) {
      await expect(setBudgetCap(db.pool, scope, 1, "session")).rejects.toThrow(/budget/i);
    }
    expect(await capOf("day:2030-01-01")).toBe("5");
  });

  it("a template whose row is missing is rejected, not created", async () => {
    await db.ownerPool.query("delete from budgets where scope = 'month'");
    await expect(setBudgetCap(db.pool, "month", 1, "session")).rejects.toThrow(/budget/i);
    expect((await db.pool.query("select 1 from budgets where scope = 'month'")).rowCount).toBe(0);
  });

  it("token_and_system_actor_cannot_set_a_cap", async () => {
    for (const actor of ["token", "system", "owner_cli", ""] as const) {
      await expect(setBudgetCap(db.pool, "day", 1, actor as never)).rejects.toThrow(/session/);
    }
    expect(await capOf("day")).toBe("15000000");
    expect((await db.ownerPool.query("select 1 from audit_log where event = 'budget.cap_changed'")).rowCount).toBe(0);
  });

  it("listBudgetTemplates shows every template with its cap and no-limit as null", async () => {
    await setCapNull("video:long");
    const list = await listBudgetTemplates(db.pool);
    expect(list.templates.map((t) => t.scope)).toEqual(Object.keys(BUDGET_DEFAULTS));
    expect(list.templates.find((t) => t.scope === "video:long")!.capMicroUsd).toBeNull();
    expect(list.templates.find((t) => t.scope === "day")!.capMicroUsd).toBe(15_000_000);
  });
});
