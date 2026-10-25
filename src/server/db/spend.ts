import type pg from "pg";
import { uuidv7 } from "@/server/core/ids";
import { cleanProviderRef, safeReason, toStorable } from "@/server/core/paid-call";
import { callKey } from "@/server/core/spend";
import { atomic, toNumber, type Claim, type Db } from "./stages";

// Spend intents + serialized budgets. Money is integer micro-USD (bigint in SQL, safe integer in TS).
//
// GLOBAL LOCK ORDER (every transaction that touches these tables, including callers that compose several
// calls in one transaction, MUST acquire row locks in this order and never go back up):
//     stage_runs row  ->  spend_intents row  ->  budgets rows (sorted by scope)
// - reserveIntent: stage row (FOR SHARE) -> inserts its own brand-new intent row -> budgets.
// - settleIntent / failIntentKnown / markUnknown: intent row (FOR UPDATE) -> budgets. They never touch the
//   stage row, so a caller combining e.g. commitStage/update stage_runs THEN settle follows the order too.
// A reserve whose insert conflicts with another transaction's uncommitted intent waits on it while holding
// only a shared stage lock; the other transaction needs only budgets (below it in the order), so no cycle.

export type IntentStatus = "pending" | "done" | "failed_known" | "unknown";

export type ReserveResult =
  | { kind: "new"; intentId: string }
  | {
      kind: "existing";
      status: IntentStatus;
      result?: unknown;
      intentId: string;
      reservedMicroUsd: number;
    }
  | { kind: "refused"; reason: "cap" | "stale_fence" };

export interface Budget {
  scope: string;
  capMicroUsd: number;
  reservedMicroUsd: number;
  spentMicroUsd: number;
}

type Q = pg.ClientBase | pg.PoolClient;

function assertMicro(name: string, v: number): void {
  if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`${name} must be a non-negative safe integer, got ${v}`);
}

function normalizeScopes(scopes: string[]): string[] {
  if (scopes.length === 0 || scopes.some((s) => typeof s !== "string" || s.length === 0)) {
    throw new RangeError("budgetScopes must be a non-empty list of non-empty strings");
  }
  return [...new Set(scopes)].sort();
}

// Locks each scope row one at a time in sorted order; returns the rows that exist.
async function lockBudgets(q: Q, scopes: string[]): Promise<Map<string, { cap: bigint; reserved: bigint; spent: bigint }>> {
  const out = new Map<string, { cap: bigint; reserved: bigint; spent: bigint }>();
  for (const scope of scopes) {
    const { rows } = await q.query<{ cap: string; reserved: string; spent: string }>(
      `select cap_micro_usd as cap, reserved_micro_usd as reserved, spent_micro_usd as spent
         from budgets where scope = $1 for update`,
      [scope],
    );
    const r = rows[0];
    if (r) out.set(scope, { cap: BigInt(r.cap), reserved: BigInt(r.reserved), spent: BigInt(r.spent) });
  }
  return out;
}

async function readExisting(q: Q, key: string): Promise<ReserveResult | null> {
  const { rows } = await q.query<{
    id: string;
    status: IntentStatus;
    result: unknown;
    reserved: string;
  }>("select id, status, result, reserved_micro_usd as reserved from spend_intents where call_key = $1", [key]);
  const r = rows[0];
  if (!r) return null;
  const base = {
    kind: "existing" as const,
    status: r.status,
    intentId: r.id,
    reservedMicroUsd: toNumber(r.reserved),
  };
  return r.result === null ? base : { ...base, result: r.result };
}

export async function reserveIntent(
  db: Db,
  claim: Claim,
  args: { stepIndex: number; toolCallIndex: number; reserveMicroUsd: number; budgetScopes: string[] },
): Promise<ReserveResult> {
  assertMicro("reserveMicroUsd", args.reserveMicroUsd);
  assertMicro("stepIndex", args.stepIndex);
  assertMicro("toolCallIndex", args.toolCallIndex);
  const scopes = normalizeScopes(args.budgetScopes);
  const key = callKey(claim.stageRunId, args.stepIndex, args.toolCallIndex);
  const amount = BigInt(args.reserveMicroUsd);

  return atomic(db, async (q): Promise<ReserveResult> => {
    // 1. The claim must still be valid on the DB clock. FOR SHARE keeps the stage row from being
    //    requeued/refenced until this transaction ends, so the reservation cannot slip past a takeover.
    const { rows: live } = await q.query(
      `select 1 from stage_runs
        where id = $1 and status = 'running' and fence = $2 and lease_owner = $3
          and lease_until > clock_timestamp()
          for share`,
      [claim.stageRunId, claim.fence, claim.workerId],
    );
    if (live.length === 0) return { kind: "refused", reason: "stale_fence" };

    // 2. Insert first (intent row is below the stage row in the lock order). A conflict means the call
    //    was already made (or is being made by a concurrent transaction: we wait for it): report it, reserve nothing.
    const intentId = uuidv7();
    const ins = await q.query(
      `insert into spend_intents
         (id, stage_run_id, step_index, tool_call_index, call_key, status, reserved_micro_usd, fence, scopes)
       values ($1,$2,$3,$4,$5,'pending',$6,$7,$8)
       on conflict (call_key) do nothing
       returning id`,
      [intentId, claim.stageRunId, args.stepIndex, args.toolCallIndex, key, args.reserveMicroUsd, claim.fence, scopes],
    );
    if (ins.rowCount === 0) {
      const existing = await readExisting(q, key);
      if (!existing) throw new Error("spend intent vanished after a call_key conflict");
      return existing;
    }

    // 3. Serialize on the budgets (sorted order), check the cap (fail closed on a missing row).
    const budgets = await lockBudgets(q, scopes);
    for (const scope of scopes) {
      const b = budgets.get(scope);
      if (!b || b.reserved + b.spent + amount > b.cap) {
        await q.query("delete from spend_intents where id = $1", [intentId]); // our own uncommitted row
        return { kind: "refused", reason: "cap" };
      }
    }

    // 4. Reserve (we inserted, so we reserve).
    const upd = await q.query(
      "update budgets set reserved_micro_usd = reserved_micro_usd + $2 where scope = any($1::text[])",
      [scopes, args.reserveMicroUsd],
    );
    if (upd.rowCount !== scopes.length) throw new Error("budget rows changed during reservation");
    return { kind: "new", intentId };
  });
}

interface IntentRow {
  id: string;
  status: IntentStatus;
  reserved: string;
  actual: string | null;
  provider_ref: string | null;
  scopes: string[];
  same_result: boolean;
}

async function lockIntent(q: Q, intentId: string, resultJson: string): Promise<IntentRow> {
  const { rows } = await q.query<IntentRow>(
    `select id, status, reserved_micro_usd as reserved, actual_micro_usd as actual, provider_ref, scopes,
            (result is not distinct from $2::jsonb) as same_result
       from spend_intents where id = $1 for update`,
    [intentId, resultJson],
  );
  const r = rows[0];
  if (!r) throw new Error(`spend intent ${intentId} not found`);
  return r;
}

// Releases the reservation from every scope it was held against and optionally records spend.
async function moveBudgets(q: Q, row: IntentRow, spentMicroUsd: number): Promise<void> {
  const scopes = [...row.scopes].sort();
  await lockBudgets(q, scopes);
  const upd = await q.query(
    `update budgets
        set reserved_micro_usd = reserved_micro_usd - $2::bigint,
            spent_micro_usd = spent_micro_usd + $3::bigint
      where scope = any($1::text[])`,
    [scopes, row.reserved, spentMicroUsd],
  );
  if (upd.rowCount !== scopes.length) throw new Error("budget rows missing while releasing a reservation");
}

// Records money that was actually spent. Deliberately NOT gated on fence/lease: the provider charged us
// whether or not this worker still owns the stage. Idempotent: same values -> no-op; different -> throws.
export async function settleIntent(
  db: Db,
  intentId: string,
  args: { actualMicroUsd: number; result: unknown; providerRef?: string },
): Promise<{ overrun: boolean }> {
  // An unusable actual (NaN, Infinity, negative, fractional, unsafe) must never make settle throw: the provider
  // already charged us. It is recorded as the reservation (worst case) with actual_invalid = true.
  const actualValid = Number.isSafeInteger(args.actualMicroUsd) && args.actualMicroUsd >= 0;
  // Defence in depth: sanitise here too so a direct caller cannot make JSON.stringify or Postgres reject the result.
  const resultJson = JSON.stringify(toStorable(args.result) ?? null);
  const ref = args.providerRef === undefined ? null : cleanProviderRef(args.providerRef);

  return atomic(db, async (q) => {
    const row = await lockIntent(q, intentId, resultJson);
    const reserved = toNumber(row.reserved);
    const actual = actualValid ? args.actualMicroUsd : reserved;
    if (row.status === "done") {
      if (row.actual === null || toNumber(row.actual) !== actual || !row.same_result || row.provider_ref !== ref) {
        throw new Error(`spend intent ${intentId} already settled with different values`);
      }
      return { overrun: actual > reserved };
    }
    if (row.status !== "pending" && row.status !== "unknown") {
      throw new Error(`spend intent ${intentId} is ${row.status}; it cannot be settled`);
    }
    await moveBudgets(q, row, actual);
    await q.query(
      `update spend_intents
          set status = 'done', actual_micro_usd = $2, result = $3::jsonb, provider_ref = $4,
              actual_invalid = $5, updated_at = now()
        where id = $1`,
      [intentId, actual, resultJson, ref, !actualValid],
    );
    return { overrun: actual > reserved };
  });
}

// Provider said it failed and nothing was charged: pending -> failed_known, reservation released.
// The reason is sanitised (safeReason: no NUL, no lone surrogates, <= 200 code points, "unknown" on any throw) so the
// jsonb write can never fail because of provider text and leave the reservation held.
export async function failIntentKnown(db: Db, intentId: string, reason: string): Promise<boolean> {
  const clean = safeReason(reason);
  return atomic(db, async (q) => {
    const row = await lockIntent(q, intentId, "null");
    if (row.status !== "pending") return false;
    await moveBudgets(q, row, 0);
    await q.query(
      "update spend_intents set status = 'failed_known', result = $2::jsonb, updated_at = now() where id = $1",
      [intentId, JSON.stringify({ error: clean })],
    );
    return true;
  });
}

// Outcome unknown (money may have been spent): pending -> unknown, reservation stays held.
export async function markUnknown(db: Db, intentId: string): Promise<boolean> {
  return atomic(db, async (q) => {
    const row = await lockIntent(q, intentId, "null");
    if (row.status !== "pending") return false;
    await q.query("update spend_intents set status = 'unknown', updated_at = now() where id = $1", [intentId]);
    return true;
  });
}

export async function getBudget(db: Db, scope: string): Promise<Budget | null> {
  const { rows } = await db.query<{ cap: string; reserved: string; spent: string }>(
    `select cap_micro_usd as cap, reserved_micro_usd as reserved, spent_micro_usd as spent
       from budgets where scope = $1`,
    [scope],
  );
  const r = rows[0];
  if (!r) return null;
  return { scope, capMicroUsd: toNumber(r.cap), reservedMicroUsd: toNumber(r.reserved), spentMicroUsd: toNumber(r.spent) };
}
