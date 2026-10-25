import { describe, expect, it } from "vitest";
import {
  BudgetRefusedError,
  KnownFailure,
  KnownFailureError,
  LeaseLostError,
  NeedsDecisionError,
  runPaidCall,
  type ClaimLike,
  type IntentStatusLike,
  type PaidCallCtx,
  type PaidCallPorts,
  type ReserveOutcome,
} from "@/server/core/paid-call";

const claim: ClaimLike = { stageRunId: "stage-1", fence: 1, workerId: "w1" };
const KEY = "stage-1:0:0";

interface Intent {
  status: IntentStatusLike;
  result?: unknown;
  reserved: number;
  attempts: number;
}

// In-memory ports mirroring the db semantics closely enough for orchestration tests.
function fakePorts(opts: { intent?: Intent; refuse?: "cap" | "stale_fence"; runTotal?: number; settleThrows?: boolean } = {}) {
  const log: string[] = [];
  let intent = opts.intent;
  const ports: PaidCallPorts = {
    async reserve(_c, args): Promise<ReserveOutcome> {
      log.push("reserve");
      if (opts.refuse) return { kind: "refused", reason: opts.refuse };
      if (!intent) {
        intent = { status: "pending", reserved: args.reserveMicroUsd, attempts: 1 };
        return { kind: "new", intentId: "i1" };
      }
      return {
        kind: "existing",
        status: intent.status,
        intentId: "i1",
        reservedMicroUsd: intent.reserved,
        attempts: intent.attempts,
        ...(intent.result === undefined ? {} : { result: intent.result }),
      };
    },
    async settle(_id, args) {
      log.push("settle");
      if (opts.settleThrows) throw new Error("db down");
      intent = { ...intent!, status: "done", result: args.result };
    },
    async failKnown(_id, reason) {
      log.push("failKnown");
      intent = { ...intent!, status: "failed_known", result: { error: reason } };
    },
    async markUnknown() {
      log.push("markUnknown");
      if (intent?.status === "pending") intent = { ...intent, status: "unknown" };
    },
    async markStageNeedsDecision() {
      log.push("needsDecision");
    },
    async reopenForRetry() {
      log.push("reopen");
      if (!intent || (intent.status !== "pending" && intent.status !== "unknown") || intent.attempts >= 2) return false;
      intent = { ...intent, status: "pending", attempts: intent.attempts + 1 };
      return true;
    },
    async runTotalMicroUsd() {
      return opts.runTotal ?? 0;
    },
  };
  return { ports, log, intent: () => intent };
}

function provider(behaviour: () => Promise<{ result: unknown; actualMicroUsd: number }>) {
  const keys: string[] = [];
  return {
    keys,
    call: async (key: string) => {
      keys.push(key);
      return behaviour();
    },
  };
}
const okProvider = () => provider(async () => ({ result: { text: "hi" }, actualMicroUsd: 7 }));

const ctx = (over: Partial<PaidCallCtx> = {}): PaidCallCtx => ({
  claim,
  stepIndex: 0,
  toolCallIndex: 0,
  reserveMicroUsd: 100,
  budgetScopes: ["g"],
  kind: "paid",
  ...over,
});

describe("runPaidCall", () => {
  it("new_intent_calls_provider_with_call_key_and_settles", async () => {
    const f = fakePorts();
    const p = okProvider();
    expect(await runPaidCall(f.ports, ctx(), p.call)).toEqual({ text: "hi" });
    expect(p.keys).toEqual([KEY]);
    expect(f.log).toEqual(["reserve", "settle"]);
  });

  it("done_intent_returns_stored_result_without_calling", async () => {
    const f = fakePorts({ intent: { status: "done", result: { text: "stored" }, reserved: 100, attempts: 1 } });
    const p = okProvider();
    expect(await runPaidCall(f.ports, ctx(), p.call)).toEqual({ text: "stored" });
    expect(p.keys).toEqual([]);
    expect(f.log).toEqual(["reserve"]);
  });

  it("pending_intent_goes_to_needs_decision_and_never_calls", async () => {
    for (const status of ["pending", "unknown"] as const) {
      const f = fakePorts({ intent: { status, reserved: 123, attempts: 1 } });
      const p = okProvider();
      const err = await runPaidCall(f.ports, ctx(), p.call).catch((e) => e);
      expect(err).toBeInstanceOf(NeedsDecisionError);
      expect(err).toMatchObject({ stageRunId: "stage-1", callKey: KEY, maxCostMicroUsd: 123 });
      expect(p.keys).toEqual([]);
      expect(f.log).toEqual(["reserve", "markUnknown", "needsDecision"]);
    }
  });

  it("paid_never_retries_even_with_huge_run_budget", async () => {
    const f = fakePorts({ intent: { status: "unknown", reserved: 1, attempts: 1 } });
    const p = okProvider();
    await expect(runPaidCall(f.ports, ctx({ reserveMicroUsd: 1, runBudgetMicroUsd: 1e12 }), p.call)).rejects.toBeInstanceOf(
      NeedsDecisionError,
    );
    expect(p.keys).toEqual([]);
    expect(f.log).not.toContain("reopen");
  });

  it("cheap_text_may_retry_once_within_run_budget", async () => {
    const f = fakePorts({ intent: { status: "unknown", reserved: 100, attempts: 1 }, runTotal: 100 });
    const p = okProvider();
    expect(await runPaidCall(f.ports, ctx({ kind: "cheap_text", runBudgetMicroUsd: 1000 }), p.call)).toEqual({ text: "hi" });
    expect(p.keys).toEqual([KEY]);
    expect(f.log).toEqual(["reserve", "reopen", "settle"]); // no second reservation, no needs_decision
    expect(f.intent()).toMatchObject({ status: "done", attempts: 2 });
  });

  it("cheap_text_over_run_budget_goes_to_needs_decision", async () => {
    const f = fakePorts({ intent: { status: "pending", reserved: 100, attempts: 1 }, runTotal: 950 });
    const p = okProvider();
    await expect(
      runPaidCall(f.ports, ctx({ kind: "cheap_text", reserveMicroUsd: 100, runBudgetMicroUsd: 1000 }), p.call),
    ).rejects.toBeInstanceOf(NeedsDecisionError);
    expect(p.keys).toEqual([]);
    expect(f.log).not.toContain("reopen");
  });

  it("cheap_text_exactly_at_run_budget_is_allowed_and_default_is_50000", async () => {
    const f = fakePorts({ intent: { status: "pending", reserved: 100, attempts: 1 }, runTotal: 49_900 });
    const p = okProvider();
    await runPaidCall(f.ports, ctx({ kind: "cheap_text", reserveMicroUsd: 100 }), p.call);
    expect(p.keys).toHaveLength(1);
    const g = fakePorts({ intent: { status: "pending", reserved: 100, attempts: 1 }, runTotal: 49_901 });
    await expect(runPaidCall(g.ports, ctx({ kind: "cheap_text", reserveMicroUsd: 100 }), okProvider().call)).rejects.toBeInstanceOf(
      NeedsDecisionError,
    );
  });

  it("cheap_text_second_retry_is_refused", async () => {
    const f = fakePorts({ intent: { status: "unknown", reserved: 100, attempts: 2 }, runTotal: 100 });
    const p = okProvider();
    await expect(runPaidCall(f.ports, ctx({ kind: "cheap_text", runBudgetMicroUsd: 1e9 }), p.call)).rejects.toBeInstanceOf(
      NeedsDecisionError,
    );
    expect(p.keys).toEqual([]);
  });

  it("known_failure_releases_reservation_and_rethrows", async () => {
    const f = fakePorts();
    const p = provider(async () => {
      throw new KnownFailure("quota exceeded");
    });
    await expect(runPaidCall(f.ports, ctx(), p.call)).rejects.toBeInstanceOf(KnownFailure);
    expect(f.log).toEqual(["reserve", "failKnown"]);
    expect(f.intent()).toMatchObject({ status: "failed_known", result: { error: "quota exceeded" } });
  });

  it("existing_failed_known_rethrows_without_calling", async () => {
    const f = fakePorts({ intent: { status: "failed_known", result: { error: "quota exceeded" }, reserved: 100, attempts: 1 } });
    const p = okProvider();
    const err: unknown = await runPaidCall(f.ports, ctx(), p.call).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KnownFailureError);
    expect((err as Error).message).toBe("quota exceeded");
    expect(p.keys).toEqual([]);
    expect(f.log).toEqual(["reserve"]);
  });

  it("unknown_failure_leaves_pending", async () => {
    const f = fakePorts();
    const p = provider(async () => {
      throw new Error("socket hang up");
    });
    await expect(runPaidCall(f.ports, ctx(), p.call)).rejects.toThrow("socket hang up");
    expect(f.log).toEqual(["reserve"]); // no failKnown, no markUnknown, no needs_decision
    expect(f.intent()?.status).toBe("pending");
  });

  it("settle_failure_propagates_and_leaves_pending", async () => {
    const f = fakePorts({ settleThrows: true });
    await expect(runPaidCall(f.ports, ctx(), okProvider().call)).rejects.toThrow("db down");
    expect(f.intent()?.status).toBe("pending");
  });

  it("refused_budget_never_calls", async () => {
    const f = fakePorts({ refuse: "cap" });
    const p = okProvider();
    await expect(runPaidCall(f.ports, ctx(), p.call)).rejects.toBeInstanceOf(BudgetRefusedError);
    expect(p.keys).toEqual([]);
  });

  it("lease_lost_never_calls", async () => {
    const f = fakePorts({ refuse: "stale_fence" });
    const p = okProvider();
    await expect(runPaidCall(f.ports, ctx(), p.call)).rejects.toBeInstanceOf(LeaseLostError);
    expect(p.keys).toEqual([]);
  });

  it("settle_runs_even_when_lease_was_lost_during_the_call", async () => {
    // The lease is lost after reserve succeeded (the fake ports have no lease gate on settle, like the real one).
    const f = fakePorts();
    let leaseLost = false;
    const p = provider(async () => {
      leaseLost = true;
      return { result: { text: "late" }, actualMicroUsd: 9 };
    });
    expect(await runPaidCall(f.ports, ctx(), p.call)).toEqual({ text: "late" });
    expect(leaseLost).toBe(true);
    expect(f.log).toEqual(["reserve", "settle"]);
    expect(f.intent()?.status).toBe("done");
  });
});
