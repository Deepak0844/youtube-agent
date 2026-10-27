import { describe, expect, it, vi } from "vitest";
import { buildEngineConfig } from "@/server/core/engine-config";
import type { PaidCallPorts } from "@/server/core/paid-call";
import { runStageWith, type StageClaim, type StageRunnerDeps, type StageRunnerPorts } from "@/server/core/stage-runner";
import type { StageContext, StageHandler } from "@/server/core/stage-handler";

const claim: StageClaim = { stageRunId: "s1", fence: 1, workerId: "w", leaseUntil: new Date(), jobId: "j" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const baseConfig = buildEngineConfig(new Map());
const job = { stageRunId: "s1", inputHash: "h" };
const out = (n: number) => ({ result: { n }, actualMicroUsd: n });

interface Spy {
  reserves: Array<{ stepIndex: number; toolCallIndex: number }>;
  commits: unknown[];
  cancels: number;
  timeOuts: string[];
}

function setup(over: Partial<StageRunnerPorts> = {}) {
  const spy: Spy = { reserves: [], commits: [], cancels: 0, timeOuts: [] };
  const paid: PaidCallPorts = {
    reserve: async (_c, a) => {
      spy.reserves.push({ stepIndex: a.stepIndex, toolCallIndex: a.toolCallIndex });
      return { kind: "new", intentId: `i${spy.reserves.length}` };
    },
    settle: async () => {},
    failKnown: async () => {},
    markUnknown: async () => {},
    markStageNeedsDecision: async () => {},
    warn: () => {},
  };
  const ports: StageRunnerPorts = {
    paid,
    claim: async () => claim,
    heartbeat: async () => true,
    cancelRequested: async () => false,
    getStage: async () => ({ id: "s1", name: "script", inputHash: "h" }),
    commit: async (_c, result) => {
      spy.commits.push(result);
      return true;
    },
    markNeedsDecision: async () => true,
    fail: async () => true,
    cancel: async () => {
      spy.cancels++;
      return "cancelled";
    },
    timeOut: async (_c, why) => {
      spy.timeOuts.push(why);
      return "failed";
    },
    ...over,
  };
  return { ports, spy };
}

const deps = (handler: StageHandler, over: Partial<StageRunnerDeps> = {}): StageRunnerDeps => ({
  provider: { call: async () => out(0) },
  ttlMs: 30,
  workerId: "w",
  handler,
  config: baseConfig,
  ...over,
});
const stepOf = (over = {}) => ({ reserveMicroUsd: 10, budgetScopes: ["g"], kind: "paid" as const, ...over });
const whenAborted = (ctx: StageContext) =>
  new Promise<never>((_, rej) => ctx.signal.addEventListener("abort", () => rej(new Error("handler saw abort"))));

describe("stage handler contract", () => {
  it("handler_result_is_committed_with_the_fence", async () => {
    const { ports, spy } = setup();
    const o = await runStageWith(ports, deps(async (ctx) => ({ ok: true, via: ctx.claim.fence })), job);
    expect(o.kind).toBe("committed");
    expect(spy.commits).toEqual([{ ok: true, via: 1 }]);
  });

  it("cancel_requested_aborts_the_signal_and_ends_cancelled_when_no_intent_is_open", async () => {
    const { ports, spy } = setup({ cancelRequested: async () => true });
    const o = await runStageWith(ports, deps((ctx) => whenAborted(ctx)), job);
    expect(o.kind).toBe("cancelled");
    expect(spy.cancels).toBe(1);
    expect(spy.commits).toEqual([]);
  });

  it("cancel_with_an_open_intent_parks_needs_decision_not_cancelled", async () => {
    const { ports, spy } = setup({ cancelRequested: async () => true, cancel: async () => "needs_decision" });
    const o = await runStageWith(ports, deps((ctx) => whenAborted(ctx)), job);
    expect(o.kind).toBe("needs_decision");
    expect(spy.commits).toEqual([]);
  });

  it("cancel_during_a_paid_call_returns_promptly_even_if_the_provider_ignores_the_signal", async () => {
    let calls = 0;
    const { ports, spy } = setup({ cancelRequested: async () => calls > 0, cancel: async () => "needs_decision" });
    const started = Date.now();
    const o = await runStageWith(
      ports,
      deps((ctx) =>
        ctx.paid(stepOf(), async () => {
          calls++;
          await sleep(2000);
          return out(5);
        }),
      ),
      job,
    );
    expect(o.kind).toBe("needs_decision");
    expect(Date.now() - started).toBeLessThan(1500);
    expect(calls).toBe(1);
    expect(spy.commits).toEqual([]);
  });

  it("no_new_paid_call_starts_after_cancel", async () => {
    const { ports, spy } = setup({ cancelRequested: async () => true });
    let tried = false;
    const o = await runStageWith(
      ports,
      deps(async (ctx) => {
        await whenAborted(ctx).catch(() => {});
        tried = true;
        return ctx.paid(stepOf(), async () => out(1));
      }),
      job,
    );
    expect(tried).toBe(true);
    expect(spy.reserves).toEqual([]);
    expect(o.kind).toBe("cancelled");
  });

  it("provider_timeout_aborts_and_parks_needs_decision_never_retries", async () => {
    let calls = 0;
    let signalAborted = false;
    const why: string[] = [];
    const { ports, spy } = setup({
      timeOut: async (_c, w) => {
        why.push(w);
        return "needs_decision";
      },
    });
    const o = await runStageWith(
      ports,
      deps((ctx) =>
        ctx.paid(stepOf({ timeoutMs: 20 }), async (_key, signal) => {
          calls++;
          signal.addEventListener("abort", () => (signalAborted = true));
          await sleep(1000);
          return out(1);
        }),
      ),
      job,
    );
    expect(o.kind).toBe("needs_decision");
    expect(calls).toBe(1);
    expect(signalAborted).toBe(true);
    expect(spy.reserves).toHaveLength(1);
    expect(why).toEqual(["provider_timeout"]);
  });

  it("a_handler_that_swallows_a_provider_timeout_still_cannot_commit", async () => {
    const { ports, spy } = setup({ timeOut: async () => "needs_decision" });
    const o = await runStageWith(
      ports,
      deps(async (ctx) => {
        await ctx
          .paid(stepOf({ timeoutMs: 20 }), async () => {
            await sleep(500);
            return out(1);
          })
          .catch(() => {});
        return "pretend all is fine";
      }),
      job,
    );
    expect(o.kind).toBe("needs_decision");
    expect(spy.commits).toEqual([]);
  });

  it("stage_timeout_aborts_and_ends_timed_out", async () => {
    const { ports, spy } = setup();
    const o = await runStageWith(ports, deps((ctx) => whenAborted(ctx), { config: { ...baseConfig, timeoutStageS: 0.03 } }), job);
    expect(o.kind).toBe("timed_out");
    expect(spy.timeOuts).toEqual(["stage_timeout"]);
    expect(spy.commits).toEqual([]);
  });

  it.each(["stage_timeout", "cancel", "lease_lost", "shutdown"] as const)(
    "abandons_a_handler_that_ignores_%s_and_stops_heartbeats",
    async (why) => {
      vi.useFakeTimers();
      try {
        const shutdown = new AbortController();
        let beats = 0;
        let rejectHandler!: (e: Error) => void;
        const { ports, spy } = setup({
          heartbeat: async () => { beats++; return why !== "lease_lost"; },
          cancelRequested: async () => why === "cancel",
        });
        const running = runStageWith(ports, deps(() => new Promise((_, reject) => { rejectHandler = reject; }), {
          config: { ...baseConfig, timeoutStageS: 0.02 },
          shutdownSignal: shutdown.signal,
        }), job);
        let outcome: string | undefined;
        void running.then((o) => { outcome = o.kind; });
        await vi.advanceTimersByTimeAsync(1);
        if (why === "shutdown") shutdown.abort();
        await vi.advanceTimersByTimeAsync(40);
        expect(outcome).toBe(why === "stage_timeout" ? "timed_out" : why === "cancel" ? "cancelled" : "lease_lost");
        const stoppedAt = beats;
        await vi.advanceTimersByTimeAsync(100);
        expect(beats).toBe(stoppedAt);
        rejectHandler(new Error("late handler failure"));
        await vi.advanceTimersByTimeAsync(0);
        expect(spy.commits).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["before_claim", "during_claim"])("shutdown_%s_never_invokes_work", async (when) => {
    const shutdown = new AbortController();
    let claims = 0;
    let handlers = 0;
    let calls = 0;
    const { ports, spy } = setup({ claim: async () => {
      claims++;
      if (when === "during_claim") shutdown.abort();
      return claim;
    } });
    if (when === "before_claim") shutdown.abort();
    const o = await runStageWith(ports, deps(async (ctx) => {
      handlers++;
      return ctx.paid(stepOf(), async () => { calls++; return out(1); });
    }, { shutdownSignal: shutdown.signal }), job);
    expect(o.kind).toBe(when === "before_claim" ? "noop" : "lease_lost");
    expect(claims).toBe(when === "before_claim" ? 0 : 1);
    expect(handlers).toBe(0);
    expect(calls).toBe(0);
    expect(spy.reserves).toEqual([]);
  });

  it("legacy_steps_stop_after_cancel_and_allow_inflight_spend_to_settle", async () => {
    let finish!: (value: ReturnType<typeof out>) => void;
    let calls = 0;
    let settles = 0;
    let cancel = false;
    const { ports, spy } = setup({ cancelRequested: async () => cancel, cancel: async () => "needs_decision" });
    ports.paid.settle = async () => { settles++; };
    const running = runStageWith(ports, {
      ...deps(async () => null), handler: undefined,
      stepsFor: () => [0, 1].map((stepIndex) => ({ ...stepOf(), stepIndex, toolCallIndex: 0 })),
      provider: { call: async () => {
        calls++;
        if (calls > 1) return out(5);
        return new Promise((resolve) => { finish = resolve; });
      } },
    }, job);
    while (!calls) await sleep(1);
    cancel = true;
    await sleep(30);
    finish(out(5));
    const o = await running;
    await sleep(1);
    expect(o.kind).toBe("needs_decision");
    expect(calls).toBe(1);
    expect(settles).toBe(1);
    expect(spy.reserves).toHaveLength(1);
    expect(spy.commits).toEqual([]);
  }, 1000);

  it.each(["handler", "legacy"])("%s_checks_abort_after_a_delayed_reserve_before_provider", async (mode) => {
    let calls = 0;
    const { ports, spy } = setup({ cancelRequested: async () => true, cancel: async () => "needs_decision" });
    const reserve = ports.paid.reserve;
    ports.paid.reserve = async (...args) => { await sleep(40); return reserve(...args); };
    const o = await runStageWith(ports, {
      ...deps((ctx) => ctx.paid(stepOf(), async () => { calls++; return out(1); })),
      ...(mode === "legacy" ? {
        handler: undefined,
        stepsFor: () => [{ ...stepOf(), stepIndex: 0, toolCallIndex: 0 }],
      } : {}),
      provider: { call: async () => { calls++; return out(1); } },
    }, job);
    await sleep(60);
    expect(o.kind).toBe("needs_decision");
    expect(calls).toBe(0);
    expect(spy.commits).toEqual([]);
  });

  it("step_indexes_are_deterministic_across_a_resume", async () => {
    const run = async () => {
      const { ports, spy } = setup();
      await runStageWith(
        ports,
        deps(async (ctx) => {
          await ctx.paid(stepOf(), async () => out(1));
          await ctx.paid(stepOf({ toolCallIndex: 2 }), async () => out(2));
          return null;
        }),
        job,
      );
      return spy.reserves;
    };
    const a = await run();
    const b = await run();
    expect(a).toEqual([
      { stepIndex: 0, toolCallIndex: 0 },
      { stepIndex: 1, toolCallIndex: 2 },
    ]);
    expect(b).toEqual(a);
  });

  it("lease_lost_aborts_signal_and_commit_is_rejected", async () => {
    const { ports, spy } = setup({ heartbeat: async () => false });
    let aborted = false;
    const o = await runStageWith(
      ports,
      deps(async (ctx) => {
        await whenAborted(ctx).catch(() => {
          aborted = true;
        });
        return "late result";
      }),
      job,
    );
    expect(aborted).toBe(true);
    expect(o.kind).toBe("lease_lost");
    expect(spy.commits).toEqual([]);
  });

  it("handler_throwing_before_any_intent_is_rethrown_for_the_attempt_cap", async () => {
    const { ports, spy } = setup();
    await expect(
      runStageWith(
        ports,
        deps(async () => {
          throw new Error("deterministic bug");
        }),
        job,
      ),
    ).rejects.toThrow("deterministic bug");
    expect(spy.cancels).toBe(0);
    expect(spy.commits).toEqual([]);
  });

  it("handler_without_config_is_refused", async () => {
    const { ports } = setup();
    await expect(runStageWith(ports, deps(async () => 1, { config: undefined }), job)).rejects.toThrow(/config/);
  });
});
