import {
  BudgetRefusedError,
  KnownFailure,
  LeaseLostError,
  NeedsDecisionError,
  runPaidCall,
  safeReason,
  type ClaimLike,
  type PaidCallOutput,
  type PaidCallPorts,
} from "./paid-call";
import type { EngineConfig } from "./engine-config";
import { createStageContext, StageAbort, type StageHandler } from "./stage-handler";

// The worker body for one stage attempt: claim -> paid steps (each through runPaidCall) -> commit. No IO here;
// everything comes through ports (the Postgres adapter is src/server/db/stage-runner-adapter.ts).
//
// - The claim uses the job's inputHash (the row's hash AT ENQUEUE TIME). If the row's input changed since, the claim
//   matches nothing and the attempt is a no-op: work queued for an older input never runs.
// - A null claim (already claimed, already finished, wrong hash, needs_decision) is a normal no-op.
// - A heartbeat runs every ttl/3 while the attempt runs; once it fails the lease is treated as lost: no further step
//   starts (reserve would refuse anyway, the DB re-checks the lease) and the timer stops.
// - NeedsDecision / LeaseLost stop the attempt WITHOUT commit (NeedsDecision already parked the stage).
// - Deterministic outcomes are TERMINAL, through fenced ports, so the reconciler never loops on them:
//     BudgetRefused -> needs_decision "budget_refused: <call key>" (a human can raise the cap);
//     KnownFailure (incl. a replayed KnownFailureError) -> failed "known_failure: <cleaned reason>",
//       UNLESS releasing its reservation failed (failKnown threw; the wrapper already warned): then the stage is left
//       running with the intent pending + reservation held, and the reconciler parks it as needs_decision after the
//       lease expires (outcome known_failure_release_failed). A terminal 'failed' would hide the held money.
// - Anything else is rethrown (the BullMQ job fails). An unknown provider error leaves its intent pending, so the
//   reconciler parks the stage; an error before any intent is bounded by the reconciler's maxAttempts.
// - Settle (inside runPaidCall) and commit are separate transactions, settle first; nothing is paid after commit.

export interface StageJob {
  stageRunId: string;
  inputHash: string;
}

export interface StageLike {
  id: string;
  name: string;
  inputHash: string;
}

export interface StageClaim extends ClaimLike {
  leaseUntil: Date;
  jobId: string;
}

export interface StageStep {
  stepIndex: number;
  toolCallIndex: number;
  reserveMicroUsd: number;
  budgetScopes: string[];
  kind: "paid" | "cheap_text";
}

export interface StageProvider {
  call(idempotencyKey: string, step: StageStep): Promise<PaidCallOutput<unknown>>;
}

export interface StageRunnerDeps {
  provider: StageProvider;
  ttlMs: number;
  workerId: string;
  stepsFor?: (stage: StageLike) => StageStep[];
  handler?: StageHandler;
  config?: EngineConfig;
  shutdownSignal?: AbortSignal;
}

export interface StageRunnerPorts {
  paid: PaidCallPorts;
  claim(args: { id: string; inputHash: string; workerId: string; ttlMs: number }): Promise<StageClaim | null>;
  heartbeat(claim: StageClaim, ttlMs: number): Promise<boolean>;
  cancelRequested?(claim: StageClaim): Promise<boolean>;
  getStage(id: string): Promise<StageLike | null>;
  commit(claim: StageClaim, result: unknown): Promise<boolean>;
  // Both fenced on claim (fence + owner + running); false = the stage has moved on.
  markNeedsDecision(claim: StageClaim, reason: string): Promise<boolean>;
  fail(claim: StageClaim, reason: string): Promise<boolean>;
  cancel?(claim: StageClaim): Promise<"cancelled" | "needs_decision" | "rejected">;
  timeOut?(claim: StageClaim, reason: "stage_timeout" | "provider_timeout"): Promise<"failed" | "needs_decision" | "rejected">;
}

export type StageOutcome =
  | { kind: "noop" }
  | { kind: "committed"; claim: StageClaim }
  | { kind: "commit_rejected"; claim: StageClaim }
  | { kind: "needs_decision"; claim: StageClaim }
  | { kind: "lease_lost"; claim: StageClaim }
  | { kind: "budget_refused"; claim: StageClaim }
  | { kind: "known_failure"; claim: StageClaim }
  | { kind: "known_failure_release_failed"; claim: StageClaim }
  | { kind: "cancelled"; claim: StageClaim }
  | { kind: "timed_out"; claim: StageClaim };

export async function runStageWith(ports: StageRunnerPorts, deps: StageRunnerDeps, job: StageJob): Promise<StageOutcome> {
  if (deps.handler && !deps.config) throw new Error("stage handler requires engine config");
  const handlerConfig = deps.config;
  const claim = await ports.claim({ id: job.stageRunId, inputHash: job.inputHash, workerId: deps.workerId, ttlMs: deps.ttlMs });
  if (!claim) return { kind: "noop" };

  let leaseLost = false;
  let cancelSeen = false;
  let stopped = false; // set once the attempt has finished its work: a finished attempt must not extend the lease
  let releaseFailed = false;
  // Observe (never hide) a failed reservation release; the wrapper still warns and rethrows the original error.
  const paid: PaidCallPorts = {
    ...ports.paid,
    failKnown: async (intentId, reason) => {
      try {
        await ports.paid.failKnown(intentId, reason);
      } catch (err) {
        releaseFailed = true;
        throw err;
      }
    },
  };
  const ctl = new AbortController();
  const abort = (why: ConstructorParameters<typeof StageAbort>[0]) => {
    if (!ctl.signal.aborted) ctl.abort(new StageAbort(why));
  };
  const onShutdown = () => abort("shutdown");
  deps.shutdownSignal?.addEventListener("abort", onShutdown, { once: true });
  let polling = false;
  const timer = setInterval(() => {
    if (stopped || polling) return;
    polling = true;
    ports.heartbeat(claim, deps.ttlMs).then(async (alive) => {
        if (!alive) {
          leaseLost = true;
          abort("lease_lost");
          clearInterval(timer);
          return;
        }
        if (ports.cancelRequested && await ports.cancelRequested(claim)) {
          cancelSeen = true;
          abort("cancel");
          clearInterval(timer);
        }
      }, () => {
        // A failed heartbeat (DB blip) lets the lease run down; the DB clock decides.
      }).catch(() => {
        // Reading the cancel flag is part of the heartbeat observation. A DB blip must not crash the attempt;
        // the lease will expire on the database clock if connectivity does not recover.
      }).finally(() => { polling = false; });
  }, Math.max(1, Math.floor(deps.ttlMs / 3)));

  let stageTimer: ReturnType<typeof setTimeout> | undefined;
  if (deps.handler) {
    stageTimer = setTimeout(() => abort("stage_timeout"), handlerConfig!.timeoutStageS * 1000);
  }

  try {
    const stage = await ports.getStage(job.stageRunId);
    if (!stage) throw new Error(`stage ${job.stageRunId} vanished after claim`);
    let result: unknown;
    let providerTimedOut = false;
    if (deps.handler) {
      const internals = createStageContext({ stage, claim, config: handlerConfig!, signal: ctl.signal, paid });
      result = await deps.handler(internals.ctx);
      providerTimedOut = internals.providerTimedOut();
    } else {
      if (!deps.stepsFor) throw new Error("stage runner requires handler or stepsFor");
      const results: unknown[] = [];
      for (const step of deps.stepsFor(stage)) {
        if (leaseLost) return { kind: "lease_lost", claim };
        results.push(await runPaidCall(paid, { claim, ...step }, (key) => deps.provider.call(key, step)));
      }
      result = { steps: results };
    }
    stopped = true;
    if (providerTimedOut) {
      const outcome = await ports.timeOut!(claim, "provider_timeout");
      return { kind: outcome === "needs_decision" ? "needs_decision" : "timed_out", claim };
    }
    if (ctl.signal.aborted) throw ctl.signal.reason;
    const committed = await ports.commit(claim, result);
    return { kind: committed ? "committed" : "commit_rejected", claim };
  } catch (err) {
    stopped = true;
    const why = err instanceof StageAbort ? err.why : ctl.signal.reason instanceof StageAbort ? ctl.signal.reason.why : null;
    if (why === "lease_lost" || leaseLost) return { kind: "lease_lost", claim };
    if (why === "cancel" || cancelSeen) {
      const outcome = await ports.cancel!(claim);
      if (outcome === "rejected") return { kind: "lease_lost", claim };
      return { kind: outcome === "needs_decision" ? "needs_decision" : "cancelled", claim };
    }
    if (why === "provider_timeout" || why === "stage_timeout") {
      const outcome = await ports.timeOut!(claim, why);
      if (outcome === "rejected") return { kind: "lease_lost", claim };
      return { kind: outcome === "needs_decision" ? "needs_decision" : "timed_out", claim };
    }
    if (why === "shutdown") return { kind: "lease_lost", claim };
    if (err instanceof NeedsDecisionError) return { kind: "needs_decision", claim };
    if (err instanceof LeaseLostError) return { kind: "lease_lost", claim };
    if (err instanceof BudgetRefusedError) {
      await ports.markNeedsDecision(claim, `budget_refused: ${err.callKey}`);
      return { kind: "budget_refused", claim };
    }
    if (err instanceof KnownFailure) {
      if (releaseFailed) return { kind: "known_failure_release_failed", claim };
      await ports.fail(claim, `known_failure: ${safeReason(err)}`);
      return { kind: "known_failure", claim };
    }
    throw err;
  } finally {
    stopped = true;
    clearInterval(timer);
    if (stageTimer) clearTimeout(stageTimer);
    deps.shutdownSignal?.removeEventListener("abort", onShutdown);
  }
}
