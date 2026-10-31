import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runStage } from "@/server/db/stage-runner-adapter";
import {
  cancelStage,
  claimStage,
  getStage,
  insertQueuedStage,
  requestCancel,
  timeoutStage,
} from "@/server/db/stages";
import { getBudget, reserveIntent } from "@/server/db/spend";
import { buildEngineConfig } from "@/server/core/engine-config";
import { callKey } from "@/server/core/spend";
import { uuidv7 } from "@/server/core/ids";
import type { StageRunnerDeps } from "@/server/core/stage-runner";
import type { StageHandler } from "@/server/core/stage-handler";
import { createFakeProvider, hangs, type FakeProvider } from "../support/fake-provider";
import { withTestDb, type TestDb } from "../support/db";
import { waitFor } from "./helpers/stage-env";

let db: TestDb;
let provider: FakeProvider;

beforeAll(async () => {
  db = await withTestDb();
});
beforeEach(async () => {
  await db.reset();
  provider = createFakeProvider({ pool: db.pool });
  await provider.init();
  await db.ownerPool.query("truncate fake_provider_calls");
  await db.pool.query("insert into budgets (scope, cap_micro_usd) values ('g', 100000000)");
});
afterAll(async () => {
  await db?.stop();
});

const H = "h1";
const config = buildEngineConfig(new Map());
const newStage = () => insertQueuedStage(db.pool, { videoId: uuidv7(), name: "script", inputHash: H });
const job = (id: string) => ({ stageRunId: id, inputHash: H });
const step = (over = {}) => ({ reserveMicroUsd: 1000, budgetScopes: ["g"], kind: "paid" as const, ...over });

function deps(handler: StageHandler, over: Partial<StageRunnerDeps> = {}): StageRunnerDeps {
  return {
    provider: { call: (key) => provider.call(key) },
    ttlMs: 300, // heartbeat every 100 ms
    workerId: "w",
    handler,
    config,
    ...over,
  };
}
const statusOf = async (id: string) => (await getStage(db.pool, id))?.status;
const intentStatus = async (id: string, i: number) =>
  (await db.pool.query("select status from spend_intents where call_key = $1", [callKey(id, i, 0)])).rows[0]?.status;

describe("stage handler on Postgres", () => {
  it("handler_result_is_committed_with_the_fence", async () => {
    const id = await newStage();
    const o = await runStage(
      db.pool,
      deps(async (ctx) => {
        const r = await ctx.paid(step(), (key) => provider.call(key));
        return { r, fence: ctx.claim.fence };
      }),
      job(id),
    );
    expect(o.kind).toBe("committed");
    const row = await getStage(db.pool, id);
    expect(row).toMatchObject({ status: "succeeded", fence: 1 });
    expect(row?.result).toMatchObject({ fence: 1 });
    expect(await provider.dbCalls(callKey(id, 0, 0))).toBe(1);
  });

  it("progress_is_written_to_the_running_row_and_replaced_at_commit", async () => {
    const id = await newStage();
    const seen: unknown[] = [];
    const o = await runStage(
      db.pool,
      deps(async (ctx) => {
        ctx.progress?.(42);
        await waitFor(async () => ((await getStage(db.pool, id))?.result as { percent?: number } | null)?.percent === 42, "percent 42 on the running row");
        seen.push((await getStage(db.pool, id))?.status);
        return { done: true };
      }),
      job(id),
    );
    expect(o.kind).toBe("committed");
    expect(seen).toEqual(["running"]);
    expect((await getStage(db.pool, id))?.result).toEqual({ done: true });
  });

  it("a_failing_progress_write_does_not_fail_the_stage", async () => {
    const id = await newStage();
    const failing = new Proxy(db.pool, {
      get(target, prop) {
        if (prop === "query") {
          return (sql: unknown, ...rest: unknown[]) =>
            typeof sql === "string" && sql.includes("'percent'")
              ? Promise.reject(new Error("progress write down"))
              : (target.query as (...a: unknown[]) => unknown)(sql, ...rest);
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const o = await runStage(
      failing,
      deps(async (ctx) => {
        ctx.progress?.(10);
        await new Promise((r) => setTimeout(r, 50));
        return { ok: 1 };
      }),
      job(id),
    );
    expect(o.kind).toBe("committed");
    expect((await getStage(db.pool, id))?.result).toEqual({ ok: 1 });
  });

  it("cancel_requested_aborts_the_signal_and_ends_cancelled_when_no_intent_is_open", async () => {
    const id = await newStage();
    let sawAbort = false;
    const p = runStage(
      db.pool,
      deps(
        (ctx) =>
          new Promise((_, rej) =>
            ctx.signal.addEventListener("abort", () => {
              sawAbort = true;
              rej(new Error("aborted"));
            }),
          ),
      ),
      job(id),
    );
    await waitFor(async () => (await statusOf(id)) === "running", "running");
    expect(await requestCancel(db.pool, id)).toBe(true);
    const o = await p;
    expect(o.kind).toBe("cancelled");
    expect(sawAbort).toBe(true);
    expect(await statusOf(id)).toBe("cancelled");
  });

  it("cancel_during_a_paid_call_parks_needs_decision_and_money_is_recorded", async () => {
    const id = await newStage();
    const slow = createFakeProvider({ pool: db.pool, script: { [callKey(id, 0, 0)]: hangs(500, { kind: "ok", actualMicroUsd: 700, result: { text: "late" } }) } });
    const p = runStage(
      db.pool,
      deps((ctx) => ctx.paid(step(), (key) => slow.call(key)), { provider: { call: (k) => slow.call(k) } }),
      job(id),
    );
    await waitFor(async () => (await intentStatus(id, 0)) === "pending", "paid call in flight");
    await requestCancel(db.pool, id);
    const o = await p;
    expect(o.kind).toBe("needs_decision");
    expect(await statusOf(id)).toBe("needs_decision");
    // the provider was not told to stop in time (it ignores the signal): its late return is still settled
    await waitFor(async () => (await intentStatus(id, 0)) === "done", "late settle");
    expect((await getBudget(db.pool, "g"))?.spentMicroUsd).toBe(700);
    expect(await statusOf(id)).toBe("needs_decision"); // result never committed
  });

  it("no_new_paid_call_starts_after_cancel", async () => {
    const id = await newStage();
    let secondError: unknown;
    const p = runStage(
      db.pool,
      deps(async (ctx) => {
        await new Promise((r) => ctx.signal.addEventListener("abort", r));
        try {
          await ctx.paid(step(), (key) => provider.call(key));
        } catch (e) {
          secondError = e;
          throw e;
        }
      }),
      job(id),
    );
    await waitFor(async () => (await statusOf(id)) === "running", "running");
    await requestCancel(db.pool, id);
    expect((await p).kind).toBe("cancelled");
    expect(secondError).toBeDefined();
    expect(provider.totalCalls()).toBe(0);
    expect((await db.pool.query("select count(*)::int n from spend_intents")).rows[0].n).toBe(0);
  });

  it.each(["handler", "legacy"])("%s_cannot_reserve_the_next_call_after_cancel_before_the_next_heartbeat", async (mode) => {
    const id = await newStage();
    const handler: StageHandler = async (ctx) => {
      await ctx.paid(step(), (key) => provider.call(key));
      await requestCancel(db.pool, id);
      return ctx.paid(step(), (key) => provider.call(key));
    };
    const o = await runStage(db.pool, deps(handler, {
      ttlMs: 60_000,
      ...(mode === "legacy" ? {
        handler: undefined,
        stepsFor: () => [0, 1].map((stepIndex) => ({ ...step(), stepIndex, toolCallIndex: 0 })),
        provider: { call: async (key) => {
          const result = await provider.call(key);
          await requestCancel(db.pool, id);
          return result;
        } },
      } : {}),
    }), job(id));
    expect(o.kind).toBe("cancelled");
    expect(await statusOf(id)).toBe("cancelled");
    expect(await provider.dbCalls(callKey(id, 0, 0))).toBe(1);
    expect(await provider.dbCalls(callKey(id, 1, 0))).toBe(0);
    expect(await intentStatus(id, 1)).toBeUndefined();
    expect((await getBudget(db.pool, "g"))?.reservedMicroUsd).toBe(0);
  });

  it.each(["handler", "legacy"])("%s_checks_cancellation_after_reserve_before_invoking_the_provider", async (mode) => {
    const id = await newStage();
    const o = await runStage(db.pool, deps((ctx) => ctx.paid(step(), (key) => provider.call(key)), {
      ttlMs: 60_000,
      ...(mode === "legacy" ? {
        handler: undefined,
        stepsFor: () => [{ ...step(), stepIndex: 0, toolCallIndex: 0 }],
      } : {}),
    }), job(id), { paid: (base) => ({ ...base, reserve: async (...args) => {
      const reservation = await base.reserve(...args);
      await requestCancel(db.pool, id);
      return reservation;
    } }) });
    expect(o.kind).toBe("needs_decision");
    expect(await statusOf(id)).toBe("needs_decision");
    expect(await intentStatus(id, 0)).toBe("unknown");
    expect(await provider.dbCalls(callKey(id, 0, 0))).toBe(0);
  });

  it("provider_timeout_aborts_and_parks_needs_decision_never_retries", async () => {
    const id = await newStage();
    const slow = createFakeProvider({ pool: db.pool, script: { [callKey(id, 0, 0)]: hangs(400) } });
    const o = await runStage(
      db.pool,
      deps((ctx) => ctx.paid(step({ timeoutMs: 50 }), (key) => slow.call(key)), { provider: { call: (k) => slow.call(k) } }),
      job(id),
    );
    expect(o.kind).toBe("needs_decision");
    expect(await statusOf(id)).toBe("needs_decision");
    // a redelivery must not call again
    const again = await runStage(db.pool, deps((ctx) => ctx.paid(step(), (key) => slow.call(key))), job(id));
    expect(again.kind).toBe("noop");
    expect(await slow.dbCalls(callKey(id, 0, 0))).toBe(1);
  });

  it("step_indexes_are_deterministic_across_a_resume", async () => {
    const id = await newStage();
    let crash = true;
    const handler: StageHandler = async (ctx) => {
      const a = await ctx.paid(step(), (key) => provider.call(key));
      if (crash) {
        crash = false;
        throw new Error("process died between steps");
      }
      const b = await ctx.paid(step(), (key) => provider.call(key));
      return { a, b };
    };
    await expect(runStage(db.pool, deps(handler), job(id))).rejects.toThrow("process died");
    expect(await statusOf(id)).toBe("running");
    await db.pool.query("update stage_runs set status = 'queued', lease_owner = null, lease_until = null where id = $1", [id]);
    const o = await runStage(db.pool, deps(handler), job(id));
    expect(o.kind).toBe("committed");
    expect(await provider.dbCalls(callKey(id, 0, 0))).toBe(1); // step 0 replayed from the stored result
    expect(await provider.dbCalls(callKey(id, 1, 0))).toBe(1);
    expect(await intentStatus(id, 1)).toBe("done");
  });

  it("lease_lost_aborts_signal_and_commit_is_rejected", async () => {
    const id = await newStage();
    let aborted = false;
    const p = runStage(
      db.pool,
      deps(async (ctx) => {
        await new Promise((r) => ctx.signal.addEventListener("abort", r));
        aborted = true;
        return "late";
      }),
      job(id),
    );
    await waitFor(async () => (await statusOf(id)) === "running", "running");
    await db.pool.query("update stage_runs set lease_until = clock_timestamp() - interval '1 second' where id = $1", [id]);
    const o = await p;
    expect(aborted).toBe(true);
    expect(o.kind).toBe("lease_lost");
    expect(await statusOf(id)).toBe("running"); // untouched: the reconciler owns it now
    expect((await getStage(db.pool, id))?.result).toBeNull();
  });

  it("handler_throwing_before_any_intent_is_bounded_by_max_attempts", async () => {
    const id = await newStage();
    await expect(
      runStage(
        db.pool,
        deps(async () => {
          throw new Error("deterministic bug");
        }),
        job(id),
      ),
    ).rejects.toThrow("deterministic bug");
    // left running with no intent: the reconciler's attempt cap (stuck-loops suite) is what ends it; no cancel/park happened
    expect(await statusOf(id)).toBe("running");
    expect((await db.pool.query("select count(*)::int n from spend_intents")).rows[0].n).toBe(0);
  });

  it("stage_timeout_ends_failed_timeout_when_no_intent_is_open", async () => {
    const id = await newStage();
    const o = await runStage(
      db.pool,
      deps((ctx) => new Promise((_, rej) => ctx.signal.addEventListener("abort", () => rej(new Error("x")))), {
        config: { ...config, timeoutStageS: 0.05 },
      }),
      job(id),
    );
    expect(o.kind).toBe("timed_out");
    expect(await getStage(db.pool, id)).toMatchObject({ status: "failed", result: { error: "stage_timeout" } });
  });
});

describe("cancelStage / timeoutStage (fenced)", () => {
  async function running() {
    const id = await newStage();
    const claim = (await claimStage(db.pool, { id, inputHash: H, workerId: "w", ttlMs: 60_000 }))!;
    return { id, claim };
  }

  it("cancels_a_running_stage_with_no_open_intent", async () => {
    const { id, claim } = await running();
    expect(await cancelStage(db.pool, claim)).toBe("cancelled");
    expect(await statusOf(id)).toBe("cancelled");
  });

  it("a_stale_fence_or_owner_cannot_cancel", async () => {
    const { id, claim } = await running();
    expect(await cancelStage(db.pool, { ...claim, fence: claim.fence + 1 })).toBe("rejected");
    expect(await cancelStage(db.pool, { ...claim, workerId: "other" })).toBe("rejected");
    expect(await statusOf(id)).toBe("running");
  });

  it("reserve_refuses_cancel_requested_under_the_stage_lock_without_changing_budgets", async () => {
    const { id, claim } = await running();
    // Hold the cancellation uncommitted: reserve must wait for the stage lock, then see the flag.
    const canceller = await db.pool.connect();
    try {
      await canceller.query("begin");
      await requestCancel(canceller, id);
      const reservation = reserveIntent(db.pool, claim, {
        stepIndex: 0, toolCallIndex: 0, reserveMicroUsd: 1000, budgetScopes: ["g"],
      });
      await canceller.query("commit");
      expect(await reservation).toEqual({ kind: "refused", reason: "cancel_requested" });
      expect(await intentStatus(id, 0)).toBeUndefined();
      expect((await getBudget(db.pool, "g"))?.reservedMicroUsd).toBe(0);
    } finally {
      await canceller.query("rollback");
      canceller.release();
    }
  });

  it("an_open_intent_parks_needs_decision_and_keeps_the_reservation", async () => {
    const { id, claim } = await running();
    await reserveIntent(db.pool, claim, { stepIndex: 0, toolCallIndex: 0, reserveMicroUsd: 1000, budgetScopes: ["g"] });
    expect(await cancelStage(db.pool, claim)).toBe("needs_decision");
    expect(await statusOf(id)).toBe("needs_decision");
    expect(await intentStatus(id, 0)).toBe("unknown");
    expect((await getBudget(db.pool, "g"))?.reservedMicroUsd).toBe(1000);
  });

  it("timeout_without_intent_fails_and_with_intent_parks", async () => {
    const a = await running();
    expect(await timeoutStage(db.pool, a.claim, "stage_timeout")).toBe("failed");
    expect(await getStage(db.pool, a.id)).toMatchObject({ status: "failed", result: { error: "stage_timeout" } });
    const b = await running();
    await reserveIntent(db.pool, b.claim, { stepIndex: 0, toolCallIndex: 0, reserveMicroUsd: 1000, budgetScopes: ["g"] });
    expect(await timeoutStage(db.pool, b.claim, "provider_timeout")).toBe("needs_decision");
    expect(await statusOf(b.id)).toBe("needs_decision");
  });
});
