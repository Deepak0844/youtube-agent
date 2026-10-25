import { describe, expect, it } from "vitest";
import {
  BudgetRefusedError,
  KnownFailure,
  KnownFailureError,
  LeaseLostError,
  NeedsDecisionError,
  runPaidCall,
  toStorable,
  cleanProviderRef,
  MAX_STORED_RESULT_BYTES,
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
}

// In-memory ports mirroring the db semantics closely enough for orchestration tests.
function fakePorts(opts: { intent?: Intent; refuse?: "cap" | "stale_fence"; settleThrows?: boolean } = {}) {
  const log: string[] = [];
  let intent = opts.intent;
  const ports: PaidCallPorts = {
    async reserve(_c, args): Promise<ReserveOutcome> {
      log.push("reserve");
      if (opts.refuse) return { kind: "refused", reason: opts.refuse };
      if (!intent) {
        intent = { status: "pending", reserved: args.reserveMicroUsd };
        return { kind: "new", intentId: "i1" };
      }
      return {
        kind: "existing",
        status: intent.status,
        intentId: "i1",
        reservedMicroUsd: intent.reserved,
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
    const f = fakePorts({ intent: { status: "done", result: { text: "stored" }, reserved: 100 } });
    const p = okProvider();
    expect(await runPaidCall(f.ports, ctx(), p.call)).toEqual({ text: "stored" });
    expect(p.keys).toEqual([]);
    expect(f.log).toEqual(["reserve"]);
  });

  it("pending_intent_goes_to_needs_decision_and_never_calls", async () => {
    for (const status of ["pending", "unknown"] as const) {
      const f = fakePorts({ intent: { status, reserved: 123 } });
      const p = okProvider();
      const err = await runPaidCall(f.ports, ctx(), p.call).catch((e) => e);
      expect(err).toBeInstanceOf(NeedsDecisionError);
      expect(err).toMatchObject({ stageRunId: "stage-1", callKey: KEY, maxCostMicroUsd: 123 });
      expect(p.keys).toEqual([]);
      expect(f.log).toEqual(["reserve", "markUnknown", "needsDecision"]);
    }
  });

  it("cheap_text_pending_goes_to_needs_decision_like_paid", async () => {
    for (const status of ["pending", "unknown"] as const) {
      const f = fakePorts({ intent: { status, reserved: 100 } });
      const p = okProvider();
      await expect(runPaidCall(f.ports, ctx({ kind: "cheap_text" }), p.call)).rejects.toBeInstanceOf(NeedsDecisionError);
      expect(p.keys).toEqual([]);
      expect(f.log).toEqual(["reserve", "markUnknown", "needsDecision"]);
    }
  });

  it("original_result_is_returned_to_the_caller_but_settle_gets_the_sanitised_one", async () => {
    const f = fakePorts();
    const original = { text: "a\u0000b", big: 5n };
    const out = await runPaidCall(f.ports, ctx(), async () => ({ result: original, actualMicroUsd: 1 }));
    expect(out).toBe(original);
    expect(f.intent()?.result).toEqual({ text: "ab", big: "5" });
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
    const f = fakePorts({ intent: { status: "failed_known", result: { error: "quota exceeded" }, reserved: 100 } });
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

  describe("toStorable fallback reason", () => {
    const throwing = (v: unknown) => ({
      get x(): never {
        throw v;
      },
    });
    const reasonOf = (v: unknown) => (toStorable(throwing(v)) as { unserializable: boolean; reason: string }).reason;

    it("fallback_reason_with_nul_is_cleaned", () => {
      expect(reasonOf(new Error("bad\u0000byte"))).toBe("badbyte");
    });
    it("fallback_reason_with_lone_surrogate_is_cleaned", () => {
      expect(reasonOf(new Error("x\ud800"))).toBe("x\uFFFD");
    });
    it("fallback_reason_cut_by_code_point_not_utf16_unit", () => {
      const r = reasonOf(new Error("a".repeat(199) + "\u{1F600}" + "tail"));
      expect(r).toBe("a".repeat(199) + "\u{1F600}");
      expect([...r]).toHaveLength(200);
      expect(r.isWellFormed()).toBe(true);
    });
    it("hostile_thrown_values_fall_back_to_unknown", () => {
      expect(reasonOf(Object.create(null))).toBe("unknown");
      expect(reasonOf({ toString: () => { throw new Error("no"); } })).toBe("unknown");
      const e = new Error("m");
      Object.defineProperty(e, "message", { get() { throw new Error("no"); } });
      expect(reasonOf(e)).toBe("unknown");
    });
  });

  it("result_exactly_1MiB_is_kept_and_1MiB_plus_one_is_truncated", () => {
    const exact = "x".repeat(MAX_STORED_RESULT_BYTES - 2); // JSON adds 2 quote bytes
    expect(toStorable(exact)).toBe(exact);
    expect(toStorable(exact + "x")).toEqual({ truncated: true, bytes: MAX_STORED_RESULT_BYTES + 1 });
  });

  it("provider_ref_with_nul_and_lone_surrogate_is_cleaned_and_capped", () => {
    expect(cleanProviderRef("a\u0000b\ud800c")).toBe("ab\uFFFDc");
    const capped = cleanProviderRef("\u{1F600}".repeat(1000)); // 4 bytes each
    expect(new TextEncoder().encode(capped).length).toBe(1024);
    expect(capped.isWellFormed()).toBe(true);
  });
});
