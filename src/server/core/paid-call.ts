import { callKey } from "./spend";

// The single gate every paid call goes through. No IO here: all effects come through injected ports.
//
// Behaviour table (call key = stageRunId:stepIndex:toolCallIndex, also the provider idempotency key):
//   reserve -> refused "cap"                 : throw BudgetRefusedError; provider NOT called.
//   reserve -> refused "stale_fence"         : throw LeaseLostError; provider NOT called.
//   reserve -> new                           : call provider with idempotencyKey = call key.
//       provider ok                          : settle(actual, result, providerRef), return result.
//       provider throws KnownFailure         : failKnown (reservation released), rethrow.
//       provider throws anything else / the
//         process dies                       : intent stays pending (outcome unknown), rethrow. The stage is NOT
//                                              marked needs_decision here; the next attempt or the reconciler does.
//   reserve -> existing done                 : return the stored result; provider NOT called.
//   reserve -> existing failed_known         : TERMINAL for this key: throw KnownFailureError (stored reason);
//                                              provider NOT called. Retrying means a new step/tool index.
//   reserve -> existing pending | unknown    :
//       kind "paid"                          : markUnknown + markStageNeedsDecision + throw NeedsDecisionError
//                                              (maxCostMicroUsd = the reservation); provider NOT called. NEVER retried.
//       kind "cheap_text"                    : retry ONCE (attempts < 2, enforced atomically by reopenForRetry) only if
//                                              runTotal + reserveMicroUsd <= runBudgetMicroUsd (default 50_000 = $0.05);
//                                              the retry reuses the existing reservation (no second reserve) and the same
//                                              idempotency key. Otherwise the needs_decision path above.
// After the provider returns, settle runs EVEN IF the lease was lost meanwhile (money is money); the caller's later
// commitStage is then rejected by the fence. If settle itself throws (DB down) the intent stays pending, so the next
// attempt goes to needs_decision (paid) rather than paying twice. DB writes are separate statements: reserve, provider,
// settle; no transaction is ever held open across the provider call.

export const DEFAULT_RUN_BUDGET_MICRO_USD = 50_000;

// Thrown by a provider adapter to declare "the call failed and we were NOT charged".
export class KnownFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnownFailure";
  }
}

// A stored KnownFailure replayed for an intent already in failed_known.
export class KnownFailureError extends KnownFailure {
  constructor(message: string) {
    super(message);
    this.name = "KnownFailureError";
  }
}

export class BudgetRefusedError extends Error {
  constructor(public readonly callKey: string) {
    super(`budget refused paid call ${callKey}`);
    this.name = "BudgetRefusedError";
  }
}

export class LeaseLostError extends Error {
  constructor(public readonly callKey: string) {
    super(`lease lost; refusing paid call ${callKey}`);
    this.name = "LeaseLostError";
  }
}

export class NeedsDecisionError extends Error {
  constructor(
    public readonly stageRunId: string,
    public readonly callKey: string,
    public readonly maxCostMicroUsd: number,
  ) {
    super(`paid call ${callKey} has an unknown outcome (up to ${maxCostMicroUsd} micro-USD); needs a decision`);
    this.name = "NeedsDecisionError";
  }
}

// Structural copies of the db types (core must not import db).
export interface ClaimLike {
  stageRunId: string;
  fence: number;
  workerId: string;
}
export type IntentStatusLike = "pending" | "done" | "failed_known" | "unknown";
export type ReserveOutcome =
  | { kind: "new"; intentId: string }
  | {
      kind: "existing";
      status: IntentStatusLike;
      result?: unknown;
      intentId: string;
      reservedMicroUsd: number;
      attempts: number;
    }
  | { kind: "refused"; reason: "cap" | "stale_fence" };

export interface PaidCallPorts {
  reserve(
    claim: ClaimLike,
    args: { stepIndex: number; toolCallIndex: number; reserveMicroUsd: number; budgetScopes: string[] },
  ): Promise<ReserveOutcome>;
  settle(intentId: string, args: { actualMicroUsd: number; result: unknown; providerRef?: string }): Promise<void>;
  failKnown(intentId: string, reason: string): Promise<void>;
  markUnknown(intentId: string): Promise<void>;
  markStageNeedsDecision(claim: ClaimLike, reason: string): Promise<void>;
  reopenForRetry(intentId: string): Promise<boolean>;
  runTotalMicroUsd(stageRunId: string): Promise<number>;
}

export interface PaidCallCtx {
  claim: ClaimLike;
  stepIndex: number;
  toolCallIndex: number;
  reserveMicroUsd: number;
  budgetScopes: string[];
  kind: "paid" | "cheap_text";
  runBudgetMicroUsd?: number;
}

export interface PaidCallOutput<T> {
  result: T;
  actualMicroUsd: number;
  providerRef?: string;
}

export async function runPaidCall<T>(
  ports: PaidCallPorts,
  ctx: PaidCallCtx,
  call: (idempotencyKey: string) => Promise<PaidCallOutput<T>>,
): Promise<T> {
  const key = callKey(ctx.claim.stageRunId, ctx.stepIndex, ctx.toolCallIndex);

  async function execute(intentId: string): Promise<T> {
    let out: PaidCallOutput<T>;
    try {
      out = await call(key);
    } catch (err) {
      if (err instanceof KnownFailure) {
        // If releasing fails the intent just stays pending (safe: never double-pays); the original error wins.
        await ports.failKnown(intentId, err.message).catch(() => {});
      }
      throw err;
    }
    await ports.settle(intentId, {
      actualMicroUsd: out.actualMicroUsd,
      result: out.result,
      ...(out.providerRef === undefined ? {} : { providerRef: out.providerRef }),
    });
    return out.result;
  }

  const r = await ports.reserve(ctx.claim, {
    stepIndex: ctx.stepIndex,
    toolCallIndex: ctx.toolCallIndex,
    reserveMicroUsd: ctx.reserveMicroUsd,
    budgetScopes: ctx.budgetScopes,
  });

  if (r.kind === "refused") {
    throw r.reason === "cap" ? new BudgetRefusedError(key) : new LeaseLostError(key);
  }
  if (r.kind === "new") return execute(r.intentId);

  if (r.status === "done") return r.result as T;
  if (r.status === "failed_known") {
    const stored = r.result as { error?: unknown } | undefined;
    throw new KnownFailureError(typeof stored?.error === "string" ? stored.error : "known failure");
  }

  // pending | unknown: the outcome of an earlier attempt is not known.
  if (ctx.kind === "cheap_text") {
    const runTotal = await ports.runTotalMicroUsd(ctx.claim.stageRunId);
    const budget = ctx.runBudgetMicroUsd ?? DEFAULT_RUN_BUDGET_MICRO_USD;
    if (runTotal + ctx.reserveMicroUsd <= budget && (await ports.reopenForRetry(r.intentId))) {
      return execute(r.intentId);
    }
  }
  await ports.markUnknown(r.intentId);
  await ports.markStageNeedsDecision(ctx.claim, `unknown outcome for paid call ${key}`);
  throw new NeedsDecisionError(ctx.claim.stageRunId, key, r.reservedMicroUsd);
}
