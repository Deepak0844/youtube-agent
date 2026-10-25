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
//   reserve -> existing pending | unknown    : markUnknown + markStageNeedsDecision + throw NeedsDecisionError
//                                              (maxCostMicroUsd = the reservation); provider NOT called. NEVER retried,
//                                              whatever `kind` is. `kind` ("paid" | "cheap_text") has NO effect yet.
//                                              A bounded cheap_text retry is DEFERRED to Phase 2: it cannot be made safe
//                                              without a provider-side idempotency lookup and an enforced call timeout
//                                              (a retry while the first call is still in flight calls the provider twice
//                                              and loses the first call's spend; a successful retry hides the first
//                                              attempt's possible charge).
// After the provider returns, settle runs EVEN IF the lease was lost meanwhile (money is money); the caller's later
// commitStage is then rejected by the fence. If settle itself throws (DB down) the intent stays pending, so the next
// attempt goes to needs_decision rather than paying twice. settle never rejects what the provider returned: the result
// is made JSON-safe first (toStorable) and an unusable actual cost is recorded as the reservation (see settleIntent);
// the caller still receives the provider's ORIGINAL result on the first attempt. DB writes are separate statements: reserve, provider,
// settle; no transaction is ever held open across the provider call.

export const MAX_STORED_RESULT_BYTES = 1024 * 1024;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const cleanString = (v: string): string => v.replace(/\u0000/g, "").replace(LONE_SURROGATE, "\uFFFD");

function walk(v: unknown, ancestors: Set<object>): unknown {
  switch (typeof v) {
    case "string":
      return cleanString(v);
    case "bigint":
      return v.toString();
    case "undefined":
    case "function":
    case "symbol":
      return null;
    case "object": {
      if (v === null) return null;
      if (ancestors.has(v)) throw new TypeError("circular structure");
      ancestors.add(v);
      try {
        const toJSON = (v as { toJSON?: unknown }).toJSON;
        if (typeof toJSON === "function") return walk(toJSON.call(v), ancestors);
        if (Array.isArray(v)) return v.map((x) => walk(x, ancestors));
        const out: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v)) out[cleanString(k)] = walk(x, ancestors);
        return out;
      } finally {
        ancestors.delete(v);
      }
    }
    default:
      return v; // number, boolean (NaN/Infinity serialise as null)
  }
}

// Makes a provider result safe to store as jsonb: never throws.
export function toStorable(value: unknown): unknown {
  try {
    const clean = walk(value, new Set());
    const json = JSON.stringify(clean ?? null);
    const bytes = new TextEncoder().encode(json).length;
    if (bytes > MAX_STORED_RESULT_BYTES) return { truncated: true, bytes };
    return JSON.parse(json);
  } catch (err) {
    return { unserializable: true, reason: String(err instanceof Error ? err.message : err).slice(0, 200) };
  }
}

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
}

export interface PaidCallCtx {
  claim: ClaimLike;
  stepIndex: number;
  toolCallIndex: number;
  reserveMicroUsd: number;
  budgetScopes: string[];
  // No effect yet (Phase 2 will use it for a bounded cheap_text retry).
  kind: "paid" | "cheap_text";
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
      actualMicroUsd: out.actualMicroUsd, // invalid values are handled (recorded as the reservation) by the db
      result: toStorable(out.result),
      ...(typeof out.providerRef === "string" ? { providerRef: cleanString(out.providerRef) } : {}),
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

  // pending | unknown: the outcome of an earlier attempt is not known. Never call again, whatever the kind.
  await ports.markUnknown(r.intentId);
  await ports.markStageNeedsDecision(ctx.claim, `unknown outcome for paid call ${key}`);
  throw new NeedsDecisionError(ctx.claim.stageRunId, key, r.reservedMicroUsd);
}
