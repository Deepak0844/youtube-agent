import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { claimStage, commitStage, heartbeat, insertQueuedStage, type Claim } from "@/server/db/stages";
import { failIntentKnown, getBudget, markUnknown, reserveIntent, settleIntent } from "@/server/db/spend";
import { callKey } from "@/server/core/spend";
import { uuidv7 } from "@/server/core/ids";
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

const TTL = 60_000;

async function claimed(workerId = "w1"): Promise<Claim> {
  const id = await insertQueuedStage(db.pool, { videoId: uuidv7(), name: "script", inputHash: "h" });
  const c = await claimStage(db.pool, { id, inputHash: "h", workerId, ttlMs: TTL });
  if (!c) throw new Error("claim failed");
  return c;
}

// What the reconciler + a new worker do after a lease is lost: requeue, then claim again (fence + 1).
async function loseLease(c: Claim, newWorker = "w2"): Promise<Claim> {
  await db.pool.query(
    "update stage_runs set status='queued', lease_owner=null, lease_until=null, attempt_seq=attempt_seq+1 where id=$1",
    [c.stageRunId],
  );
  const next = await claimStage(db.pool, { id: c.stageRunId, inputHash: "h", workerId: newWorker, ttlMs: TTL });
  if (!next) throw new Error("reclaim failed");
  return next;
}

async function budget(scope: string, cap: number, reserved = 0, spent = 0): Promise<void> {
  await db.pool.query(
    "insert into budgets (scope, cap_micro_usd, reserved_micro_usd, spent_micro_usd) values ($1,$2,$3,$4)",
    [scope, cap, reserved, spent],
  );
}

async function counts(scope: string): Promise<{ reserved: number; spent: number }> {
  const b = await getBudget(db.pool, scope);
  return { reserved: b!.reservedMicroUsd, spent: b!.spentMicroUsd };
}

async function intentRow(id: string) {
  const { rows } = await db.pool.query("select * from spend_intents where id=$1", [id]);
  return rows[0];
}

async function reserve(c: Claim, amount: number, scopes: string[], toolCallIndex = 0, stepIndex = 0) {
  return reserveIntent(db.pool, c, { stepIndex, toolCallIndex, reserveMicroUsd: amount, budgetScopes: scopes });
}

describe("reserveIntent", () => {
  it("second_reserve_with_same_call_key_returns_existing_and_does_not_reserve_again", async () => {
    await budget("g", 1_000_000);
    const c = await claimed();
    const first = await reserve(c, 100, ["g"]);
    expect(first.kind).toBe("new");
    const second = await reserve(c, 100, ["g"]);
    expect(second).toMatchObject({ kind: "existing", status: "pending" });
    if (first.kind === "new" && second.kind === "existing") expect(second.intentId).toBe(first.intentId);
    expect(await counts("g")).toEqual({ reserved: 100, spent: 0 });
    const { rows } = await db.pool.query("select call_key, scopes, fence from spend_intents");
    expect(rows).toHaveLength(1);
    expect(rows[0].call_key).toBe(callKey(c.stageRunId, 0, 0));
    expect(rows[0].scopes).toEqual(["g"]);
    expect(Number(rows[0].fence)).toBe(c.fence);
  });

  it("existing_returns_settled_result_without_reserving", async () => {
    await budget("g", 1_000_000);
    const c = await claimed();
    const r = await reserve(c, 100, ["g"]);
    if (r.kind !== "new") throw new Error("expected new");
    await settleIntent(db.pool, r.intentId, { actualMicroUsd: 60, result: { text: "hi" }, providerRef: "p1" });
    const again = await reserve(c, 100, ["g"]);
    expect(again).toEqual({ kind: "existing", status: "done", result: { text: "hi" }, intentId: r.intentId });
    expect(await counts("g")).toEqual({ reserved: 0, spent: 60 });
  });

  it("parallel_reservations_cannot_both_pass_the_cap", async () => {
    const pool = new pg.Pool({ connectionString: db.pool.options.connectionString, max: 10 });
    try {
      const c = await claimed();
      for (let round = 0; round < 20; round++) {
        const scope = `round-${round}`;
        await budget(scope, 1_000_000);
        const res = await Promise.all(
          [0, 1].map((i) =>
            reserveIntent(pool, c, { stepIndex: round, toolCallIndex: i, reserveMicroUsd: 600_000, budgetScopes: [scope] }),
          ),
        );
        expect(res.filter((r) => r.kind === "new"), `round ${round}`).toHaveLength(1);
        expect(res.filter((r) => r.kind === "refused" && r.reason === "cap")).toHaveLength(1);
        expect(await counts(scope)).toEqual({ reserved: 600_000, spent: 0 });
      }
    } finally {
      await pool.end();
    }
  });

  it("same_call_key_raced_over_different_scopes_reserves_exactly_once", async () => {
    // Different scope sets do not serialize on a shared budget lock, so only the call_key unique
    // index + "reserve only when the insert inserted" keeps this exactly-once.
    const pool = new pg.Pool({ connectionString: db.pool.options.connectionString, max: 10 });
    try {
      const c = await claimed();
      for (let round = 0; round < 20; round++) {
        await budget(`x${round}`, 1_000_000);
        await budget(`y${round}`, 1_000_000);
        const mk = (scope: string) =>
          reserveIntent(pool, c, { stepIndex: round, toolCallIndex: 0, reserveMicroUsd: 100, budgetScopes: [scope] });
        const res = await Promise.all([mk(`x${round}`), mk(`y${round}`)]);
        expect(res.filter((r) => r.kind === "new"), `round ${round}`).toHaveLength(1);
        expect(res.filter((r) => r.kind === "existing")).toHaveLength(1);
        const x = await counts(`x${round}`);
        const y = await counts(`y${round}`);
        expect(x.reserved + y.reserved).toBe(100);
      }
    } finally {
      await pool.end();
    }
  });

  it("cap_boundary_exactly_equal_is_allowed_one_microdollar_over_is_refused", async () => {
    await budget("eq", 1_000);
    await budget("over", 1_000);
    await budget("withspent", 1_000, 300, 200);
    const c = await claimed();
    expect((await reserve(c, 1_000, ["eq"], 0)).kind).toBe("new");
    expect(await reserve(c, 1_001, ["over"], 1)).toEqual({ kind: "refused", reason: "cap" });
    expect((await reserve(c, 500, ["withspent"], 2)).kind).toBe("new"); // 300+200+500 == cap
    expect(await reserve(c, 1, ["withspent"], 3)).toEqual({ kind: "refused", reason: "cap" });
    expect(await counts("over")).toEqual({ reserved: 0, spent: 0 });
    const { rows } = await db.pool.query("select tool_call_index from spend_intents order by tool_call_index");
    expect(rows.map((r) => r.tool_call_index)).toEqual([0, 2]);
  });

  it("stale_fence_cannot_reserve", async () => {
    await budget("g", 1_000_000);
    const old = await claimed();
    const fresh = await loseLease(old);
    expect(await reserve(old, 100, ["g"])).toEqual({ kind: "refused", reason: "stale_fence" });
    expect(await counts("g")).toEqual({ reserved: 0, spent: 0 });
    // right fence, wrong owner
    expect(await reserve({ ...fresh, workerId: "impostor" }, 100, ["g"])).toEqual({ kind: "refused", reason: "stale_fence" });
    expect((await reserve(fresh, 100, ["g"])).kind).toBe("new");
  });

  it("stale_claim_cannot_even_read_an_existing_intent", async () => {
    await budget("g", 1_000_000);
    const old = await claimed();
    expect((await reserve(old, 100, ["g"])).kind).toBe("new");
    await loseLease(old);
    expect(await reserve(old, 100, ["g"])).toEqual({ kind: "refused", reason: "stale_fence" });
  });

  it("expired_lease_cannot_reserve", async () => {
    await budget("g", 1_000_000);
    const c = await claimed();
    await db.pool.query("update stage_runs set lease_until = now() - interval '1 second' where id=$1", [c.stageRunId]);
    expect(await reserve(c, 100, ["g"])).toEqual({ kind: "refused", reason: "stale_fence" });
    expect(await counts("g")).toEqual({ reserved: 0, spent: 0 });
  });

  it("non_running_stage_cannot_reserve", async () => {
    await budget("g", 1_000_000);
    const c = await claimed();
    await db.pool.query("update stage_runs set status='cancelled' where id=$1", [c.stageRunId]);
    expect(await reserve(c, 100, ["g"])).toEqual({ kind: "refused", reason: "stale_fence" });
  });

  it("missing_budget_row_is_refused", async () => {
    await budget("g", 1_000_000);
    const c = await claimed();
    expect(await reserve(c, 100, ["nope"])).toEqual({ kind: "refused", reason: "cap" });
    expect(await reserve(c, 100, ["g", "nope"], 1)).toEqual({ kind: "refused", reason: "cap" });
    expect(await counts("g")).toEqual({ reserved: 0, spent: 0 });
    const { rows } = await db.pool.query("select 1 from spend_intents");
    expect(rows).toHaveLength(0);
  });

  it("reserve_across_two_scopes_reserves_both_or_neither", async () => {
    await budget("a", 1_000);
    await budget("b", 10);
    const c = await claimed();
    expect(await reserve(c, 50, ["a", "b"])).toEqual({ kind: "refused", reason: "cap" });
    expect(await counts("a")).toEqual({ reserved: 0, spent: 0 });
    expect(await counts("b")).toEqual({ reserved: 0, spent: 0 });
    await db.pool.query("update budgets set cap_micro_usd = 100 where scope='b'");
    expect((await reserve(c, 50, ["b", "a", "a"], 1)).kind).toBe("new"); // duplicates in scopes collapse
    expect(await counts("a")).toEqual({ reserved: 50, spent: 0 });
    expect(await counts("b")).toEqual({ reserved: 50, spent: 0 });
  });

  it("reserve_joins_callers_transaction_and_rolls_back_with_it", async () => {
    await budget("g", 1_000_000);
    const c = await claimed();
    const client = await db.pool.connect();
    try {
      await client.query("begin");
      const r = await reserveIntent(client, c, { stepIndex: 0, toolCallIndex: 0, reserveMicroUsd: 500, budgetScopes: ["g"] });
      expect(r.kind).toBe("new");
      await client.query("rollback");
    } finally {
      client.release();
    }
    expect(await counts("g")).toEqual({ reserved: 0, spent: 0 });
    expect((await db.pool.query("select 1 from spend_intents")).rows).toHaveLength(0);
    // a refusal inside a caller transaction does not poison it
    const client2 = await db.pool.connect();
    try {
      await client2.query("begin");
      expect(await reserveIntent(client2, c, { stepIndex: 0, toolCallIndex: 1, reserveMicroUsd: 2_000_000, budgetScopes: ["g"] })).toEqual({ kind: "refused", reason: "cap" });
      expect((await reserveIntent(client2, c, { stepIndex: 0, toolCallIndex: 2, reserveMicroUsd: 5, budgetScopes: ["g"] })).kind).toBe("new");
      await client2.query("commit");
    } finally {
      client2.release();
    }
    expect(await counts("g")).toEqual({ reserved: 5, spent: 0 });
  });

  it("no_deadlock_when_two_scopes_are_locked_in_opposite_order", async () => {
    const pool = new pg.Pool({ connectionString: db.pool.options.connectionString, max: 10 });
    try {
      await budget("A", 1_000_000_000);
      await budget("B", 1_000_000_000);
      const c = await claimed();
      let n = 0;
      for (let round = 0; round < 30; round++) {
        const calls = Array.from({ length: 6 }, (_, i) => {
          const scopes = i % 2 === 0 ? ["A", "B"] : ["B", "A"];
          return reserveIntent(pool, c, { stepIndex: round, toolCallIndex: i, reserveMicroUsd: 10, budgetScopes: scopes });
        });
        const res = await Promise.all(calls); // a deadlock would reject with 40P01
        n += res.filter((r) => r.kind === "new").length;
      }
      expect(n).toBe(180);
      expect(await counts("A")).toEqual({ reserved: 1_800, spent: 0 });
      expect(await counts("B")).toEqual({ reserved: 1_800, spent: 0 });
    } finally {
      await pool.end();
    }
  });

  it("invalid_amounts_and_arguments_throw_before_touching_the_db", async () => {
    await budget("g", 1_000);
    const c = await claimed();
    const bad = [-1, 1.5, NaN, Infinity, 2 ** 53];
    for (const amt of bad) await expect(reserve(c, amt, ["g"])).rejects.toThrow(RangeError);
    await expect(reserve(c, 1, [])).rejects.toThrow(RangeError);
    await expect(reserve(c, 1, ["g"], -1)).rejects.toThrow(RangeError);
    await expect(reserve(c, 1, ["g"], 0, 1.5)).rejects.toThrow(RangeError);
    expect(await counts("g")).toEqual({ reserved: 0, spent: 0 });
  });
});

describe("settle / fail / unknown", () => {
  async function pendingIntent(amount = 1_000, scopes = ["g"]) {
    for (const s of scopes) {
      const exists = await getBudget(db.pool, s);
      if (!exists) await budget(s, 10_000_000);
    }
    const c = await claimed();
    const r = await reserve(c, amount, scopes);
    if (r.kind !== "new") throw new Error("expected new");
    return { c, intentId: r.intentId };
  }

  it("settle_releases_reservation_and_adds_actual", async () => {
    const { intentId } = await pendingIntent(1_000, ["g", "h"]);
    expect(await counts("g")).toEqual({ reserved: 1_000, spent: 0 });
    const out = await settleIntent(db.pool, intentId, { actualMicroUsd: 700, result: { ok: 1 }, providerRef: "ref-1" });
    expect(out).toEqual({ overrun: false });
    for (const s of ["g", "h"]) expect(await counts(s)).toEqual({ reserved: 0, spent: 700 });
    const row = await intentRow(intentId);
    expect(row).toMatchObject({ status: "done", provider_ref: "ref-1", result: { ok: 1 } });
    expect(Number(row.actual_micro_usd)).toBe(700);
  });

  it("settle_after_lease_lost_still_records_the_spend", async () => {
    const { c, intentId } = await pendingIntent(1_000);
    await loseLease(c);
    await settleIntent(db.pool, intentId, { actualMicroUsd: 900, result: null });
    expect(await counts("g")).toEqual({ reserved: 0, spent: 900 });
    expect((await intentRow(intentId)).status).toBe("done");
  });

  it("settle_is_idempotent_and_never_double_counts", async () => {
    const { intentId } = await pendingIntent(1_000);
    const args = { actualMicroUsd: 400, result: { a: 1, b: [2] }, providerRef: "r" };
    await settleIntent(db.pool, intentId, args);
    await settleIntent(db.pool, intentId, { ...args, result: { b: [2], a: 1 } }); // same jsonb, different key order
    await Promise.all([settleIntent(db.pool, intentId, args), settleIntent(db.pool, intentId, args)]);
    expect(await counts("g")).toEqual({ reserved: 0, spent: 400 });
  });

  it("settle_with_different_values_throws", async () => {
    const { intentId } = await pendingIntent(1_000);
    await settleIntent(db.pool, intentId, { actualMicroUsd: 400, result: { a: 1 }, providerRef: "r" });
    await expect(settleIntent(db.pool, intentId, { actualMicroUsd: 401, result: { a: 1 }, providerRef: "r" })).rejects.toThrow();
    await expect(settleIntent(db.pool, intentId, { actualMicroUsd: 400, result: { a: 2 }, providerRef: "r" })).rejects.toThrow();
    await expect(settleIntent(db.pool, intentId, { actualMicroUsd: 400, result: { a: 1 }, providerRef: "other" })).rejects.toThrow();
    expect(await counts("g")).toEqual({ reserved: 0, spent: 400 });
  });

  it("settle_rejects_unknown_intent_failed_intent_and_bad_amounts", async () => {
    await expect(settleIntent(db.pool, uuidv7(), { actualMicroUsd: 1, result: null })).rejects.toThrow();
    const { intentId } = await pendingIntent(1_000);
    for (const amt of [-1, 0.5, NaN, 2 ** 53]) {
      await expect(settleIntent(db.pool, intentId, { actualMicroUsd: amt, result: null })).rejects.toThrow(RangeError);
    }
    expect(await counts("g")).toEqual({ reserved: 1_000, spent: 0 });
    await failIntentKnown(db.pool, intentId, "provider rejected");
    await expect(settleIntent(db.pool, intentId, { actualMicroUsd: 5, result: null })).rejects.toThrow();
    expect(await counts("g")).toEqual({ reserved: 0, spent: 0 });
  });

  it("overrun_is_recorded_not_clamped", async () => {
    const { intentId } = await pendingIntent(1_000);
    const out = await settleIntent(db.pool, intentId, { actualMicroUsd: 1_500, result: null });
    expect(out).toEqual({ overrun: true });
    expect(await counts("g")).toEqual({ reserved: 0, spent: 1_500 });
    // idempotent re-settle reports the same flag
    expect(await settleIntent(db.pool, intentId, { actualMicroUsd: 1_500, result: null })).toEqual({ overrun: true });
  });

  it("failIntentKnown_releases_reservation", async () => {
    const { intentId } = await pendingIntent(1_000, ["g", "h"]);
    expect(await failIntentKnown(db.pool, intentId, "bad request")).toBe(true);
    for (const s of ["g", "h"]) expect(await counts(s)).toEqual({ reserved: 0, spent: 0 });
    const row = await intentRow(intentId);
    expect(row.status).toBe("failed_known");
    expect(row.result).toEqual({ error: "bad request" });
    expect(await failIntentKnown(db.pool, intentId, "again")).toBe(false); // no double release
    expect(await markUnknown(db.pool, intentId)).toBe(false);
    expect(await counts("g")).toEqual({ reserved: 0, spent: 0 });
  });

  it("markUnknown_keeps_reservation", async () => {
    const { intentId } = await pendingIntent(1_000);
    expect(await markUnknown(db.pool, intentId)).toBe(true);
    expect(await counts("g")).toEqual({ reserved: 1_000, spent: 0 });
    expect((await intentRow(intentId)).status).toBe("unknown");
    expect(await markUnknown(db.pool, intentId)).toBe(false);
    expect(await failIntentKnown(db.pool, intentId, "x")).toBe(false);
    expect(await counts("g")).toEqual({ reserved: 1_000, spent: 0 });
    // an unknown intent can later be settled once the truth is learned: releases the held reservation
    await settleIntent(db.pool, intentId, { actualMicroUsd: 800, result: null });
    expect(await counts("g")).toEqual({ reserved: 0, spent: 800 });
  });

  it("done_intents_are_never_changed_by_fail_or_unknown", async () => {
    const { intentId } = await pendingIntent(1_000);
    await settleIntent(db.pool, intentId, { actualMicroUsd: 300, result: null });
    expect(await failIntentKnown(db.pool, intentId, "x")).toBe(false);
    expect(await markUnknown(db.pool, intentId)).toBe(false);
    expect(await counts("g")).toEqual({ reserved: 0, spent: 300 });
    expect((await intentRow(intentId)).status).toBe("done");
  });
});

describe("lease clock", () => {
  it("heartbeat_inside_a_long_open_transaction_measures_from_actual_time", async () => {
    const c = await claimed();
    const client = await db.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_sleep(0.3)");
      expect(await heartbeat(client, c, 100)).toBe(true);
      const { rows } = await client.query<{ alive: boolean }>(
        "select lease_until > clock_timestamp() as alive from stage_runs where id=$1",
        [c.stageRunId],
      );
      expect(rows[0]!.alive).toBe(true); // with now() the new lease would already be ~200ms in the past
      await client.query("commit");
    } finally {
      client.release();
    }
  });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = () => sleep(Math.floor(Math.random() * 6));

// reserved must equal the sum over pending/unknown intents, spent the sum over done intents.
async function expectConsistent(scope: string): Promise<void> {
  const { rows } = await db.pool.query<{ reserved: string; spent: string }>(
    `select coalesce(sum(reserved_micro_usd) filter (where status in ('pending','unknown')), 0) as reserved,
            coalesce(sum(actual_micro_usd) filter (where status = 'done'), 0) as spent
       from spend_intents where $1 = any(scopes)`,
    [scope],
  );
  const b = await counts(scope);
  expect(b).toEqual({ reserved: Number(rows[0]!.reserved), spent: Number(rows[0]!.spent) });
}

describe("lock order: stage_runs -> spend_intents -> budgets", () => {
  async function pendingOn(c: Claim, scope: string, toolCallIndex: number, step = 0, amount = 1_000): Promise<string> {
    const r = await reserve(c, amount, [scope], toolCallIndex, step);
    if (r.kind !== "new") throw new Error("expected new");
    return r.intentId;
  }

  it("no_deadlock_between_reserve_and_stage_then_settle_transactions", async () => {
    const pool = new pg.Pool({ connectionString: db.pool.options.connectionString, max: 10 });
    try {
      const c = await claimed();
      for (let round = 0; round < 30; round++) {
        const scope = `lo1-${round}`;
        await budget(scope, 1_000_000_000);
        const target = await pendingOn(c, scope, 0, round);
        const txA = (async () => {
          const client = await pool.connect();
          try {
            await client.query("begin");
            await client.query("update stage_runs set updated_at = now() where id = $1", [c.stageRunId]);
            await jitter();
            if (round % 2 === 0) await settleIntent(client, target, { actualMicroUsd: 400, result: null });
            else await failIntentKnown(client, target, "x");
            await jitter();
            await client.query("commit");
          } catch (err) {
            await client.query("rollback").catch(() => {});
            throw err;
          } finally {
            client.release();
          }
        })();
        const res = (async () => {
          await jitter();
          return reserveIntent(pool, c, { stepIndex: round, toolCallIndex: 1, reserveMicroUsd: 500, budgetScopes: [scope] });
        })();
        const [, r] = await Promise.all([txA, res]); // a deadlock rejects with 40P01
        expect(r.kind, `round ${round}`).toBe("new");
        await expectConsistent(scope);
      }
    } finally {
      await pool.end();
    }
  });

  it("no_deadlock_between_reserve_and_commitStage_then_settle", async () => {
    const pool = new pg.Pool({ connectionString: db.pool.options.connectionString, max: 10 });
    try {
      for (let round = 0; round < 30; round++) {
        const c = await claimed(`w${round}`);
        const scope = `lo2-${round}`;
        await budget(scope, 1_000_000_000);
        const target = await pendingOn(c, scope, 0);
        const txA = (async () => {
          const client = await pool.connect();
          try {
            await client.query("begin");
            expect(await commitStage(client, c, { ok: true })).toBe(true);
            await jitter();
            await settleIntent(client, target, { actualMicroUsd: 700, result: { done: 1 } });
            await jitter();
            await client.query("commit");
          } catch (err) {
            await client.query("rollback").catch(() => {});
            throw err;
          } finally {
            client.release();
          }
        })();
        const res = (async () => {
          await jitter();
          return reserveIntent(pool, c, { stepIndex: 0, toolCallIndex: 1, reserveMicroUsd: 500, budgetScopes: [scope] });
        })();
        const [, r] = await Promise.all([txA, res]);
        expect(["new", "refused"], `round ${round}`).toContain(r.kind); // refused(stale_fence) if commit won
        await expectConsistent(scope);
      }
    } finally {
      await pool.end();
    }
  });

  it("no_deadlock_when_two_reserves_hit_the_same_call_key_concurrently", async () => {
    const pool = new pg.Pool({ connectionString: db.pool.options.connectionString, max: 10 });
    try {
      const c = await claimed();
      for (let round = 0; round < 30; round++) {
        const scope = `lo3-${round}`;
        await budget(scope, 1_000_000_000);
        const other = await pendingOn(c, scope, 0, round);
        const mk = async () => {
          await jitter();
          return reserveIntent(pool, c, { stepIndex: round, toolCallIndex: 1, reserveMicroUsd: 500, budgetScopes: [scope] });
        };
        const settle = (async () => {
          await jitter();
          await settleIntent(pool, other, { actualMicroUsd: 300, result: null });
        })();
        const [a, b] = await Promise.all([mk(), mk(), settle]);
        expect([a.kind, b.kind].sort(), `round ${round}`).toEqual(["existing", "new"]);
        await expectConsistent(scope);
      }
    } finally {
      await pool.end();
    }
  });
});

describe("overlapping transactions on one intent", () => {
  // Intent X is the one both transactions go for; intent Y keeps a second reservation on the same
  // budget so a double release cannot hide behind the >= 0 check.
  async function setup() {
    await budget("g", 1_000_000);
    const c = await claimed();
    const x = await reserve(c, 1_000, ["g"], 0);
    const y = await reserve(c, 1_000, ["g"], 1);
    if (x.kind !== "new" || y.kind !== "new") throw new Error("expected new");
    expect(await counts("g")).toEqual({ reserved: 2_000, spent: 0 });
    return { x: x.intentId, y: y.intentId };
  }

  // A runs (uncommitted), B starts while A is open and must block until A commits.
  async function overlap<A, B>(
    first: (q: pg.PoolClient) => Promise<A>,
    second: (q: pg.PoolClient) => Promise<B>,
  ): Promise<{ a: A; b: PromiseSettledResult<B>; blocked: boolean }> {
    const ca = await db.pool.connect();
    const cb = await db.pool.connect();
    try {
      await ca.query("begin");
      await cb.query("begin");
      const a = await first(ca);
      let settled = false;
      const bp = second(cb).finally(() => {
        settled = true;
      });
      bp.catch(() => {});
      await sleep(300);
      const blocked = !settled;
      await ca.query("commit");
      const b = (await Promise.allSettled([bp]))[0]!;
      if (b.status === "fulfilled") await cb.query("commit");
      else await cb.query("rollback");
      return { a, b, blocked };
    } finally {
      ca.release();
      cb.release();
    }
  }

  it("settle_in_overlapping_transactions_never_double_counts", async () => {
    const { x } = await setup();
    const args = { actualMicroUsd: 700, result: { ok: 1 }, providerRef: "r" };
    const out = await overlap(
      (q) => settleIntent(q, x, args),
      (q) => settleIntent(q, x, args),
    );
    expect(out.blocked).toBe(true);
    expect(out.b.status).toBe("fulfilled"); // identical values: no-op
    expect(await counts("g")).toEqual({ reserved: 1_000, spent: 700 });
    await expectConsistent("g");

    // different values in the overlapping transaction: must throw, never add
    const { x: x2 } = await (async () => {
      const c = await claimed("w9");
      const r = await reserve(c, 1_000, ["g"], 0);
      if (r.kind !== "new") throw new Error("expected new");
      return { x: r.intentId };
    })();
    const out2 = await overlap(
      (q) => settleIntent(q, x2, { actualMicroUsd: 100, result: null }),
      (q) => settleIntent(q, x2, { actualMicroUsd: 200, result: null }),
    );
    expect(out2.blocked).toBe(true);
    expect(out2.b.status).toBe("rejected");
    expect(await counts("g")).toEqual({ reserved: 1_000, spent: 800 });
    await expectConsistent("g");
  });

  it("failIntentKnown_in_overlapping_transactions_never_double_releases", async () => {
    const { x } = await setup();
    const out = await overlap(
      (q) => failIntentKnown(q, x, "a"),
      (q) => failIntentKnown(q, x, "b"),
    );
    expect(out.a).toBe(true);
    expect(out.blocked).toBe(true);
    expect(out.b).toEqual({ status: "fulfilled", value: false });
    expect(await counts("g")).toEqual({ reserved: 1_000, spent: 0 });
    await expectConsistent("g");
  });

  it("settle_racing_failIntentKnown_has_exactly_one_winner", async () => {
    // settle wins, fail loses
    let { x } = await setup();
    const out = await overlap(
      (q) => settleIntent(q, x, { actualMicroUsd: 700, result: null }),
      (q) => failIntentKnown(q, x, "late"),
    );
    expect(out.blocked).toBe(true);
    expect(out.b).toEqual({ status: "fulfilled", value: false });
    expect(await counts("g")).toEqual({ reserved: 1_000, spent: 700 });
    expect((await intentRow(x)).status).toBe("done");
    await expectConsistent("g");

    await db.reset();
    // fail wins, settle loses (throws)
    ({ x } = await setup());
    const out2 = await overlap(
      (q) => failIntentKnown(q, x, "first"),
      (q) => settleIntent(q, x, { actualMicroUsd: 700, result: null }),
    );
    expect(out2.blocked).toBe(true);
    expect(out2.b.status).toBe("rejected");
    expect(await counts("g")).toEqual({ reserved: 1_000, spent: 0 });
    expect((await intentRow(x)).status).toBe("failed_known");
    await expectConsistent("g");
  });
});
