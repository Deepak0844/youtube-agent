import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claimStage, commitStage, getStage, insertQueuedStage, markStageNeedsDecision, type Claim } from "@/server/db/stages";
import { getBudget, settleIntent, reserveIntent } from "@/server/db/spend";
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
  await db.ownerPool.query("truncate fake_provider_calls");
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

  it("cheap_text_pending_goes_to_needs_decision_like_paid", async () => {
    const id = await newStage();
    const key = callKey(id, 0, 0);
    const p = createFakeProvider({ pool: db.pool, script: { [key]: throwsUnknown() } });
    const c1 = await claim(id, "w1");
    await expect(runPaidCall(ports, ctx(c1, { kind: "cheap_text" }), callWith(p))).rejects.toThrow("socket hang up");
    await requeueNow(id);
    const c2 = await claim(id, "w2");
    await expect(runPaidCall(ports, ctx(c2, { kind: "cheap_text" }), callWith(p))).rejects.toBeInstanceOf(NeedsDecisionError);
    expect(await p.dbCalls(key)).toBe(1);
    expect(await budget()).toEqual({ reserved: 1000, spent: 0 });
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

  // Settle must never reject what the provider returned: the money is already spent.
  describe("settle survives hostile provider output", () => {
    async function settled(result: unknown, actualMicroUsd = 7) {
      const id = await newStage();
      const key = callKey(id, 0, 0);
      const c = await claim(id, "w1");
      const out = await runPaidCall(ports, ctx(c), async () => ({ result, actualMicroUsd, providerRef: "r" }));
      const row = await intentOf(key);
      expect(row.status).toBe("done");
      return { out, row, key, id, c };
    }

    it("settle_survives_nul_char_in_result", async () => {
      const { row } = await settled({ text: "a\u0000b", "k\u0000": 1 });
      expect(row.result).toEqual({ text: "ab", k: 1 });
      expect(await budget()).toEqual({ reserved: 0, spent: 7 });
    });

    it("settle_survives_lone_surrogate", async () => {
      const { row } = await settled({ text: "x\ud800y\udc00z" });
      expect(row.result).toEqual({ text: "x\uFFFDy\uFFFDz" });
      expect(await budget()).toEqual({ reserved: 0, spent: 7 });
    });

    it("settle_survives_bigint_in_result", async () => {
      const { row } = await settled({ n: 12345678901234567890n, u: undefined, a: [undefined] });
      expect(row.result).toEqual({ n: "12345678901234567890", u: null, a: [null] });
      expect(await budget()).toEqual({ reserved: 0, spent: 7 });
    });

    it("settle_survives_circular_result", async () => {
      const a: Record<string, unknown> = { name: "loop" };
      a.self = a;
      const { row } = await settled(a);
      expect(row.result).toMatchObject({ unserializable: true });
      expect(await budget()).toEqual({ reserved: 0, spent: 7 });
    });

    it("settle_survives_huge_result", async () => {
      const { row } = await settled({ blob: "x".repeat(2 * 1024 * 1024) });
      expect(row.result).toMatchObject({ truncated: true });
      expect(row.result.bytes).toBeGreaterThan(1024 * 1024);
      expect(await budget()).toEqual({ reserved: 0, spent: 7 });
    });

    for (const [name, bad] of [
      ["nan_actual_is_recorded_as_reserved_with_flag", Number.NaN],
      ["fractional_actual_is_recorded_as_reserved_with_flag", 1.5],
      ["negative_actual_is_recorded_as_reserved_with_flag", -3],
      ["infinite_actual_is_recorded_as_reserved_with_flag", Number.POSITIVE_INFINITY],
    ] as const) {
      it(name, async () => {
        const { row } = await settled({ text: "ok" }, bad);
        expect(Number(row.actual_micro_usd)).toBe(1000); // the reservation (worst case)
        expect(row.actual_invalid).toBe(true);
        expect(await budget()).toEqual({ reserved: 0, spent: 1000 });
      });
    }

    it("valid_overrun_is_recorded_not_clamped", async () => {
      const { row } = await settled({ text: "ok" }, 5000);
      expect(Number(row.actual_micro_usd)).toBe(5000);
      expect(row.actual_invalid).toBe(false);
      expect(await budget()).toEqual({ reserved: 0, spent: 5000 });
    });

    it("first_attempt_returns_original_result_replay_returns_sanitised", async () => {
      const original = { text: "a\u0000b", n: 5n };
      const { out, id } = await settled(original);
      expect(out).toBe(original);
      await requeueNow(id);
      const c2 = await claim(id, "w2");
      const replay = await runPaidCall(ports, ctx(c2), callWith(provider));
      expect(replay).toEqual({ text: "ab", n: "5" });
      expect(provider.totalCalls()).toBe(0);
    });
  });

  // The provider was called and money spent: nothing it returns may stop settle from running.
  describe("settle last resort", () => {
    async function settledRaw(returned: unknown) {
      const id = await newStage();
      const key = callKey(id, 0, 0);
      const c = await claim(id, "w1");
      let calls = 0;
      const out = await runPaidCall(ports, ctx(c), async () => {
        calls++;
        return returned as never;
      });
      const row = await intentOf(key);
      expect(calls).toBe(1);
      expect(row.status).toBe("done");
      return { out, row };
    }
    const throwingGetter = (v: unknown) => ({
      get x(): never {
        throw v;
      },
    });
    async function expectFallbackReason(thrown: unknown, reason: string) {
      const { row } = await settledRaw({ result: throwingGetter(thrown), actualMicroUsd: 7 });
      expect(row.result).toEqual({ unserializable: true, reason });
      expect(await budget()).toEqual({ reserved: 0, spent: 7 });
    }

    it("fallback_reason_with_nul_is_cleaned", () => expectFallbackReason(new Error("bad\u0000byte"), "badbyte"));
    it("fallback_reason_with_lone_surrogate_is_cleaned", () => expectFallbackReason(new Error("x\ud800"), "x\uFFFD"));
    it("fallback_reason_cut_by_code_point_not_utf16_unit", () =>
      expectFallbackReason(new Error("a".repeat(199) + "\u{1F600}x"), "a".repeat(199) + "\u{1F600}"));
    it("thrown_null_prototype_object_still_settles", () => expectFallbackReason(Object.create(null), "unknown"));
    it("thrown_value_with_throwing_toString_still_settles", () =>
      expectFallbackReason({ toString: () => { throw new Error("no"); } }, "unknown"));
    it("error_with_throwing_message_getter_still_settles", () => {
      const e = new Error("m");
      Object.defineProperty(e, "message", { get() { throw new Error("no"); } });
      return expectFallbackReason(e, "unknown");
    });

    it("provider_returns_undefined_still_settles_as_reserved_flagged", async () => {
      const { out, row } = await settledRaw(undefined);
      expect(out).toBeUndefined();
      expect(row.result).toEqual({ unserializable: true, reason: "unknown" });
      expect(row.actual_invalid).toBe(true);
      expect(row.provider_ref).toBeNull();
      expect(await budget()).toEqual({ reserved: 0, spent: 1000 });
    });

    it("provider_returns_non_object_still_settles_as_reserved_flagged", async () => {
      const { out, row } = await settledRaw("just a string");
      expect(out).toBe("just a string");
      expect(row.result).toEqual({ unserializable: true, reason: "unknown" });
      expect(row.actual_invalid).toBe(true);
      expect(await budget()).toEqual({ reserved: 0, spent: 1000 });
    });

    it("settleIntent_called_directly_with_circular_result_does_not_throw", async () => {
      const id = await newStage();
      const c = await claim(id, "w1");
      const r = await reserveIntent(db.pool, c, { stepIndex: 0, toolCallIndex: 0, reserveMicroUsd: 1000, budgetScopes: ["g"] });
      if (r.kind !== "new") throw new Error("expected new");
      const a: Record<string, unknown> = {};
      a.self = a;
      await settleIntent(db.pool, r.intentId, { actualMicroUsd: 9, result: a, providerRef: "r\u0000" });
      const row = await intentOf(callKey(id, 0, 0));
      expect(row.status).toBe("done");
      expect(row.result).toMatchObject({ unserializable: true });
      expect(row.provider_ref).toBe("r");
      expect(await budget()).toEqual({ reserved: 0, spent: 9 });
    });

    it("result_exactly_1MiB_is_kept_and_1MiB_plus_one_is_truncated", async () => {
      const max = 1024 * 1024;
      const kept = await settledRaw({ result: "x".repeat(max - 2), actualMicroUsd: 1 });
      expect(kept.row.result).toBe("x".repeat(max - 2));
      const cut = await settledRaw({ result: "x".repeat(max - 1), actualMicroUsd: 1 });
      expect(cut.row.result).toEqual({ truncated: true, bytes: max + 1 });
    });

    it("provider_ref_with_nul_and_lone_surrogate_is_cleaned (and a huge providerRef is capped at 1 KiB)", async () => {
      const a = await settledRaw({ result: "ok", actualMicroUsd: 1, providerRef: "a\u0000b\ud800c" });
      expect(a.row.provider_ref).toBe("ab\uFFFDc");
      const b = await settledRaw({ result: "ok", actualMicroUsd: 1, providerRef: "r".repeat(100_000) });
      expect(b.row.provider_ref).toHaveLength(1024);
    });
  });
});
