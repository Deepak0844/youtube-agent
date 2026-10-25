import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claimStage, commitStage, getStage, insertQueuedStage, markStageNeedsDecision, type Claim } from "@/server/db/stages";
import { getBudget, reopenForRetry, reserveIntent, runTotalMicroUsd } from "@/server/db/spend";
import { createPgPaidCallPorts } from "@/server/db/paid-call-adapter";
import {
  BudgetRefusedError,
  KnownFailureError,
  LeaseLostError,
  NeedsDecisionError,
  runPaidCall,
  type PaidCallPorts,
} from "@/server/core/paid-call";
import { callKey } from "@/server/core/spend";
import { uuidv7 } from "@/server/core/ids";
import { createFakeProvider, hangs, knownFailure, ok, throwsUnknown, type FakeProvider } from "../support/fake-provider";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
let provider: FakeProvider;
let ports: PaidCallPorts;
beforeAll(async () => {
  db = await withTestDb();
  ports = createPgPaidCallPorts(db.pool);
});
beforeEach(async () => {
  await db.reset();
  provider = createFakeProvider({ pool: db.pool });
  await provider.init();
  await db.pool.query("truncate fake_provider_calls");
  await db.pool.query("insert into budgets (scope, cap_micro_usd) values ('g', 1000000)");
});
afterAll(async () => {
  await db?.stop();
});

const TTL = 60_000;

async function newStage(): Promise<string> {
  return insertQueuedStage(db.pool, { videoId: uuidv7(), name: "script", inputHash: "h" });
}
async function claim(id: string, workerId: string, ttlMs = TTL): Promise<Claim> {
  const c = await claimStage(db.pool, { id, inputHash: "h", workerId, ttlMs });
  if (!c) throw new Error("claim failed");
  return c;
}
// What the reconciler will do (Task 5 not built yet): requeue a running stage whose lease expired on the DB clock.
async function requeueExpired(id: string): Promise<boolean> {
  const r = await db.pool.query(
    `update stage_runs set status='queued', lease_owner=NULL, lease_until=NULL
      where id=$1 and status='running' and lease_until < clock_timestamp()`,
    [id],
  );
  return r.rowCount === 1;
}
async function requeueNow(id: string): Promise<void> {
  await db.pool.query("update stage_runs set status='queued', lease_owner=NULL, lease_until=NULL where id=$1", [id]);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ctx(c: Claim, over: Partial<Parameters<typeof runPaidCall>[1]> = {}) {
  return { claim: c, stepIndex: 0, toolCallIndex: 0, reserveMicroUsd: 1000, budgetScopes: ["g"], kind: "paid" as const, ...over };
}
const callWith = (p: FakeProvider) => (key: string) =>
  p.call(key) as Promise<{ result: { text: string }; actualMicroUsd: number; providerRef: string }>;

async function budget() {
  const b = await getBudget(db.pool, "g");
  return { reserved: b!.reservedMicroUsd, spent: b!.spentMicroUsd };
}
async function intentOf(key: string) {
  const { rows } = await db.pool.query("select * from spend_intents where call_key=$1", [key]);
  return rows[0];
}

describe("runPaidCall against Postgres", () => {
  it("happy_path_settles_and_records_spend", async () => {
    const id = await newStage();
    const c = await claim(id, "w1");
    const out = await runPaidCall(ports, ctx(c), callWith(provider));
    expect(out).toEqual({ text: "ok" });
    expect(await budget()).toEqual({ reserved: 0, spent: 1 });
    expect(await provider.dbCalls(callKey(id, 0, 0))).toBe(1);
  });

  it("crash_before_provider_call_then_resume_goes_to_needs_decision", async () => {
    const id = await newStage();
    const c1 = await claim(id, "w1");
    // Worker 1 reserved and died before calling the provider.
    expect((await ports.reserve(c1, ctx(c1))).kind).toBe("new");
    await requeueNow(id);
    const c2 = await claim(id, "w2");
    const err = await runPaidCall(ports, ctx(c2), callWith(provider)).catch((e) => e);
    expect(err).toBeInstanceOf(NeedsDecisionError);
    expect(err).toMatchObject({ maxCostMicroUsd: 1000 });
    expect(await provider.dbCalls(callKey(id, 0, 0))).toBe(0);
    expect((await getStage(db.pool, id))?.status).toBe("needs_decision");
    expect((await intentOf(callKey(id, 0, 0))).status).toBe("unknown");
    expect(await budget()).toEqual({ reserved: 1000, spent: 0 }); // money stays held until a human decides
  });

  it("crash_after_provider_returned_before_settle_goes_to_needs_decision", async () => {
    const id = await newStage();
    const c1 = await claim(id, "w1");
    const dying: PaidCallPorts = {
      ...ports,
      settle: async () => {
        throw new Error("process died before settle");
      },
    };
    await expect(runPaidCall(dying, ctx(c1), callWith(provider))).rejects.toThrow("died");
    expect(await provider.dbCalls(callKey(id, 0, 0))).toBe(1);
    await requeueNow(id);
    const c2 = await claim(id, "w2");
    await expect(runPaidCall(ports, ctx(c2), callWith(provider))).rejects.toBeInstanceOf(NeedsDecisionError);
    expect(await provider.dbCalls(callKey(id, 0, 0))).toBe(1); // never paid twice
    expect((await getStage(db.pool, id))?.status).toBe("needs_decision");
  });

  it("resume_after_settle_reuses_the_result_and_calls_zero_times", async () => {
    const id = await newStage();
    const c1 = await claim(id, "w1");
    await runPaidCall(ports, ctx(c1), callWith(createFakeProvider({ script: { [callKey(id, 0, 0)]: ok(5, { text: "first" }) } })));
    await requeueNow(id);
    const c2 = await claim(id, "w2");
    const out = await runPaidCall(ports, ctx(c2), callWith(provider));
    expect(out).toEqual({ text: "first" });
    expect(provider.totalCalls()).toBe(0);
    expect(await provider.dbCalls(callKey(id, 0, 0))).toBe(0);
    expect(await budget()).toEqual({ reserved: 0, spent: 5 });
  });

  it("lease_expires_during_call_money_recorded_stage_result_rejected", async () => {
    const id = await newStage();
    const key = callKey(id, 0, 0);
    const p = createFakeProvider({ pool: db.pool, script: { [key]: hangs(300, ok(42, { text: "slow" })) } });
    await db.pool.query("select 1");
    const c1 = await claim(id, "w1", 100);
    const first = runPaidCall(ports, ctx(c1), callWith(p));
    // wait for the lease to expire on the DB clock, then requeue + second worker claims (fence 2)
    let requeued = false;
    for (let i = 0; i < 40 && !requeued; i++) {
      await sleep(20);
      requeued = await requeueExpired(id);
    }
    expect(requeued).toBe(true);
    const c2 = await claim(id, "w2");
    expect(c2.fence).toBe(c1.fence + 1);

    expect(await first).toEqual({ text: "slow" }); // settle succeeded despite the lost lease
    expect(await budget()).toEqual({ reserved: 0, spent: 42 });
    expect(await commitStage(db.pool, c1, { text: "slow" })).toBe(false); // fence rejects the stale commit
    expect((await getStage(db.pool, id))?.status).toBe("running"); // still w2's

    // second worker runs the same step: reuses the settled result, no new provider call
    expect(await runPaidCall(ports, ctx(c2), callWith(p))).toEqual({ text: "slow" });
    expect(p.calls.get(key)).toBe(1);
    expect(await p.dbCalls(key)).toBe(1);
    expect(await commitStage(db.pool, c2, { text: "slow" })).toBe(true);
  });

  it("two_workers_same_step_after_requeue_never_double_call", async () => {
    const id = await newStage();
    const key = callKey(id, 0, 0);
    const p = createFakeProvider({ pool: db.pool, script: { [key]: hangs(300, ok(42, { text: "slow" })) } });
    await db.pool.query("select 1");
    const c1 = await claim(id, "w1", 100);
    const first = runPaidCall(ports, ctx(c1), callWith(p));
    let requeued = false;
    for (let i = 0; i < 40 && !requeued; i++) {
      await sleep(20);
      requeued = await requeueExpired(id);
    }
    expect(requeued).toBe(true);
    const c2 = await claim(id, "w2");
    // w1 is still inside the provider call: w2 must not call; it parks the stage.
    await expect(runPaidCall(ports, ctx(c2), callWith(p))).rejects.toBeInstanceOf(NeedsDecisionError);
    expect(await first).toEqual({ text: "slow" });
    expect(p.calls.get(key)).toBe(1);
    expect(await p.dbCalls(key)).toBe(1);
    expect(await budget()).toEqual({ reserved: 0, spent: 42 }); // late settle from 'unknown' still lands
    expect((await intentOf(key)).status).toBe("done");
  });

  it("budget_reserved_released_after_known_failure", async () => {
    const id = await newStage();
    const key = callKey(id, 0, 0);
    const p = createFakeProvider({ pool: db.pool, script: { [key]: knownFailure("quota") } });
    const c = await claim(id, "w1");
    await expect(runPaidCall(ports, ctx(c), callWith(p))).rejects.toThrow("quota");
    expect(await budget()).toEqual({ reserved: 0, spent: 0 });
    expect((await intentOf(key)).status).toBe("failed_known");
    // terminal for this key: no second provider call
    await expect(runPaidCall(ports, ctx(c), callWith(p))).rejects.toBeInstanceOf(KnownFailureError);
    expect(await p.dbCalls(key)).toBe(1);
    expect(await budget()).toEqual({ reserved: 0, spent: 0 });
  });

  it("unknown_failure_leaves_pending_with_reservation_held", async () => {
    const id = await newStage();
    const key = callKey(id, 0, 0);
    const p = createFakeProvider({ pool: db.pool, script: { [key]: throwsUnknown() } });
    const c = await claim(id, "w1");
    await expect(runPaidCall(ports, ctx(c), callWith(p))).rejects.toThrow("socket hang up");
    expect((await intentOf(key)).status).toBe("pending");
    expect((await getStage(db.pool, id))?.status).toBe("running");
    expect(await budget()).toEqual({ reserved: 1000, spent: 0 });
  });

  it("refusals_never_call_the_provider", async () => {
    const id = await newStage();
    const c = await claim(id, "w1");
    await expect(runPaidCall(ports, ctx(c, { reserveMicroUsd: 2_000_000 }), callWith(provider))).rejects.toBeInstanceOf(
      BudgetRefusedError,
    );
    await requeueNow(id);
    const c2 = await claim(id, "w2");
    await expect(runPaidCall(ports, ctx(c), callWith(provider))).rejects.toBeInstanceOf(LeaseLostError); // stale claim c
    expect(c2.fence).toBe(c.fence + 1);
    expect(provider.totalCalls()).toBe(0);
  });

  it("cheap_text_retries_once_reusing_the_reservation_then_needs_decision", async () => {
    const id = await newStage();
    const key = callKey(id, 0, 0);
    const p = createFakeProvider({ pool: db.pool, script: { [key]: [throwsUnknown(), throwsUnknown(), ok(3, { text: "x" })] } });
    const cheap = (c: Claim) => ctx(c, { kind: "cheap_text", reserveMicroUsd: 1000 });
    const c1 = await claim(id, "w1");
    await expect(runPaidCall(ports, cheap(c1), callWith(p))).rejects.toThrow("socket hang up");
    await requeueNow(id);
    const c2 = await claim(id, "w2");
    await expect(runPaidCall(ports, cheap(c2), callWith(p))).rejects.toThrow("socket hang up"); // the one retry, fails again
    expect(await budget()).toEqual({ reserved: 1000, spent: 0 }); // still ONE reservation
    expect((await intentOf(key)).attempts).toBe(2);
    await requeueNow(id);
    const c3 = await claim(id, "w3");
    await expect(runPaidCall(ports, cheap(c3), callWith(p))).rejects.toBeInstanceOf(NeedsDecisionError);
    expect(await p.dbCalls(key)).toBe(2); // never a third attempt
  });

  it("cheap_text_over_run_budget_does_not_retry", async () => {
    const id = await newStage();
    const key = callKey(id, 0, 0);
    const p = createFakeProvider({ pool: db.pool, script: { [key]: throwsUnknown() } });
    const c1 = await claim(id, "w1");
    await expect(runPaidCall(ports, ctx(c1, { kind: "cheap_text" }), callWith(p))).rejects.toThrow();
    await requeueNow(id);
    const c2 = await claim(id, "w2");
    await expect(
      runPaidCall(ports, ctx(c2, { kind: "cheap_text", runBudgetMicroUsd: 1500 }), callWith(p)),
    ).rejects.toBeInstanceOf(NeedsDecisionError); // runTotal 1000 + 1000 > 1500
    expect(await p.dbCalls(key)).toBe(1);
  });

  it("needs_decision_stage_status_is_set_only_for_the_current_fence", async () => {
    const id = await newStage();
    const c1 = await claim(id, "w1");
    await requeueNow(id);
    const c2 = await claim(id, "w2");
    expect(await markStageNeedsDecision(db.pool, c1, "stale")).toBe(false);
    expect((await getStage(db.pool, id))?.status).toBe("running");
    expect(await markStageNeedsDecision(db.pool, { ...c2, workerId: "someone-else" }, "wrong owner")).toBe(false);
    expect(await markStageNeedsDecision(db.pool, c2, "current")).toBe(true);
    expect((await getStage(db.pool, id))?.status).toBe("needs_decision");
    expect(await markStageNeedsDecision(db.pool, c2, "again")).toBe(false); // no longer running
  });

  it("reopen_for_retry_is_single_shot_and_run_total_counts_held_and_spent", async () => {
    const id = await newStage();
    const c = await claim(id, "w1");
    const r = await reserveIntent(db.pool, c, { stepIndex: 0, toolCallIndex: 0, reserveMicroUsd: 500, budgetScopes: ["g"] });
    if (r.kind !== "new") throw new Error("expected new");
    expect(await runTotalMicroUsd(db.pool, id)).toBe(500);
    const both = await Promise.all([reopenForRetry(db.pool, r.intentId), reopenForRetry(db.pool, r.intentId)]);
    expect(both.filter(Boolean)).toHaveLength(1); // racing reopens: exactly one wins
    expect(await reopenForRetry(db.pool, r.intentId)).toBe(false);
    expect((await intentOf(callKey(id, 0, 0))).attempts).toBe(2);
  });
});
